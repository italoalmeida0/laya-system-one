//! laya-serve: self-contained HTTP server for laya-system-one.
//!
//! ONE binary per platform (linux/win/mac x arm64/x64, musl = zero deps).
//! Embeds: ONNX Runtime (statically linked via `ort`), HF tokenizers
//! (pure Rust), Axum HTTP server. The JS side only spawns this binary
//! and proxies `/v1/systemone` over localhost HTTP.
//!
//! Wire protocol: 100% compatible with TypeSafe Jev (/v1/systemone).

mod prompt;
mod schema;

use std::path::PathBuf;
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::Json, routing::post, Router};
use anyhow::anyhow;
use clap::Parser;
use ort::session::{builder::GraphOptimizationLevel, Session};
use tokenizers::Tokenizer;
use tower_http::cors::CorsLayer;
use tracing::info;

use prompt::PromptBuilder;
use schema::*;

#[derive(Parser, Debug)]
#[command(name = "laya-serve", about = "Self-contained laya-system-one inference server")]
struct Args {
    /// Model directory (model.onnx, tokenizer.json, rl_agent_config.json)
    #[arg(long, default_value = "models")]
    model_dir: PathBuf,
    /// Bind host
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// Bind port (0 = pick free port, prints it for the spawner)
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// Intra-op threads (0 = ORT default)
    #[arg(long, default_value_t = 0)]
    threads: usize,
    /// Bearer API key (optional; also LAYA_API_KEY)
    #[arg(long)]
    api_key: Option<String>,
}

struct AppState {
    // ort::Session needs &mut per run and is not Sync: guard with Mutex.
    // Inference is sequential (batch=1 loop), same as the JS engine.
    session: std::sync::Mutex<Session>,
    prompts: std::sync::Mutex<PromptBuilder>,
    max_len: usize,
    head_max_len: usize,
    temperatures: Vec<f32>,
    api_key: Option<String>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args = Args::parse();
    let api_key = args.api_key.or_else(|| std::env::var("LAYA_API_KEY").ok());

    // ---- ONNX Runtime init (ort 2.x: init returns () once committed) ----
    ort::init().with_name("laya-serve").commit();

    // ort::Error is not Send/Sync-compatible with anyhow's `?` in this
    // context: map to strings explicitly.
    fn oe<T, E: std::fmt::Debug>(r: Result<T, E>) -> anyhow::Result<T> {
        r.map_err(|e| anyhow::anyhow!("{e:?}"))
    }
    let model_path = args.model_dir.join("model.onnx");
    info!("loading {}", model_path.display());
    // ORT API 22 (the last Intel dylib, used by the mac-x64-legacy feature)
    // rejects ORT_ENABLE_LAYOUT/ORT_ENABLE_ALL - max valid is EXTENDED.
    // Level2 already covers the fusions that matter for a CPU transformer
    // (GELU, LayerNorm, Attention), so the legacy build uses it.
    // NOTE: if the 1.22 optimizer itself segfaults on this graph, drop to
    // Disabled via the LAYA_ORT_NO_OPTIMIZE env (CI diagnosis knob).
    #[cfg(feature = "mac-x64-legacy")]
    let opt_level = if std::env::var("LAYA_ORT_NO_OPTIMIZE").is_ok() {
        GraphOptimizationLevel::Disable
    } else {
        GraphOptimizationLevel::Level2
    };
    #[cfg(not(feature = "mac-x64-legacy"))]
    let opt_level = GraphOptimizationLevel::Level3;
    let session = if args.threads > 0 {
        oe(oe(oe(Session::builder()?.with_optimization_level(opt_level))?
            .with_intra_threads(args.threads))?
            .commit_from_file(&model_path))?
    } else {
        oe(oe(Session::builder()?.with_optimization_level(opt_level))?
            .commit_from_file(&model_path))?
    };

    // ---- Tokenizer (pure Rust, reads tokenizer.json directly) ----
    let tok_path = args.model_dir.join("tokenizer.json");
    let tokenizer =
        Tokenizer::from_file(&tok_path).map_err(|e| anyhow::anyhow!("{e:?}"))?;

    // ---- Config ----
    let cfg_path = args.model_dir.join("rl_agent_config.json");
    let (max_len, head_max_len, temperatures) = read_config(&cfg_path);

    let prompts = PromptBuilder::new(
        tokenizer.clone(),
        mask_token_id(&tokenizer),
        cls_token_id(&tokenizer),
        sep_token_id(&tokenizer),
    );

    let state = Arc::new(AppState {
        session: std::sync::Mutex::new(session),
        prompts: std::sync::Mutex::new(prompts),
        max_len,
        head_max_len,
        temperatures,
        api_key,
    });

    let app = Router::new()
        .route("/v1/systemone", post(systemone))
        .route("/health", axum::routing::get(health))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener =
        tokio::net::TcpListener::bind(format!("{}:{}", args.host, args.port)).await?;
    let addr = listener.local_addr()?;
    // Machine-readable line for the JS spawner.
    println!("LAYA_READY {addr}");
    info!("listening on {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "backend": "laya-serve" }))
}

async fn systemone(
    State(st): State<Arc<AppState>>,
    req: axum::extract::Request,
) -> Result<Json<OutBody>, (StatusCode, Json<serde_json::Value>)> {
    // Auth (optional)
    if let Some(key) = &st.api_key {
        let ok = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == format!("Bearer {key}"))
            .unwrap_or(false);
        if !ok {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Unauthorized" })),
            ));
        }
    }
    let bytes = axum::body::to_bytes(req.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|e| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({ "error": format!("read body: {e}") })),
            )
        })?;
    let body: InBody = serde_json::from_slice(&bytes).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": format!("invalid body: {e}") })),
        )
    })?;

    if body.questions.is_empty() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "missing state/questions" })),
        ));
    }

    // NOTE: Session is not Sync; run inference on a blocking thread with a
    // per-request &mut borrow via Mutex. Throughput: sequential, matches
    // current JS behavior (batch=1 loop). A pool comes later if needed.
    let st2 = st.clone();
    let out = tokio::task::spawn_blocking(move || infer_all(&st2, &body))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("task: {e}") })),
            )
        })??;
    Ok(Json(out))
}

fn infer_all(st: &AppState, body: &InBody) -> Result<OutBody, (StatusCode, Json<serde_json::Value>)> {
    use ort::value::Tensor;

    let model_name = body.model.clone().unwrap_or_else(|| "laya-multilingual".into());
    let mut answers = serde_json::Map::new();
    let mut total_in = 0usize;

    for (qid, qdef) in &body.questions {
        let qtype = qdef.qtype.as_str();
        let internal = prompt::InternalQ::from_def(qid, qdef);
        let (ids, markers) = {
            let mut prompts = st.prompts.lock().unwrap();
            prompts.build(&body.state, &internal, st.max_len, st.head_max_len)
        };
        total_in += ids.len();

        let s = ids.len();
        let m = markers.len();
        let ids_i64: Vec<i64> = ids.iter().map(|&v| v as i64).collect();
        let attn = vec![1i64; s];
        let mp: Vec<i64> = markers.iter().map(|&v| v as i64).collect();
        let mm: Vec<bool> = vec![true; m];
        let qt: Vec<i64> = vec![match qtype {
            "choice" => 0,
            "score" => 1,
            _ => 2,
        }];

        // Session needs &mut: serialize through the Mutex (batch=1 loop,
        // same as the JS engine).
        let err500 = |what: &str, e: std::fmt::Arguments| -> (StatusCode, Json<serde_json::Value>) {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("{what}: {e:?}") })),
            )
        };
        let logits: Vec<f32> = {
            let mut session = st.session.lock().unwrap();
            let t_ids = Tensor::from_array((vec![1, s], ids_i64.into_boxed_slice()))
                .map_err(|e| err500("input_ids", format_args!("{e:?}")))?;
            let t_attn = Tensor::from_array((vec![1, s], attn.into_boxed_slice()))
                .map_err(|e| err500("attention_mask", format_args!("{e:?}")))?;
            let t_mp = Tensor::from_array((vec![1, m], mp.into_boxed_slice()))
                .map_err(|e| err500("marker_pos", format_args!("{e:?}")))?;
            let t_mm = Tensor::from_array((vec![1, m], mm.into_boxed_slice()))
                .map_err(|e| err500("marker_mask", format_args!("{e:?}")))?;
            let t_qt = Tensor::from_array((vec![1], qt.into_boxed_slice()))
                .map_err(|e| err500("qtype", format_args!("{e:?}")))?;
            let outputs = session
                .run(ort::inputs![
                    "input_ids" => t_ids,
                    "attention_mask" => t_attn,
                    "marker_pos" => t_mp,
                    "marker_mask" => t_mm,
                    "qtype" => t_qt,
                ])
                .map_err(|e| err500("infer", format_args!("{e:?}")))?;
            let (_shape, data) = outputs["logits"]
                .try_extract_tensor::<f32>()
                .map_err(|e| err500("logits", format_args!("{e:?}")))?;
            data.to_vec()
        };

        let row = &logits[..m.min(logits.len())];
        let temp = st
            .temperatures
            .get(match qtype {
                "choice" => 0,
                "score" => 1,
                _ => 2,
            })
            .copied()
            .unwrap_or(1.0);
        answers.insert(qid.clone(), prompt::decode(&internal, qdef, row, temp));
    }

    Ok(OutBody {
        model: model_name,
        answers: serde_json::Value::Object(answers),
        usage: Usage {
            input_tokens: total_in,
            output_tokens: body.questions.len() * 4,
        },
    })
}

fn read_config(path: &std::path::Path) -> (usize, usize, Vec<f32>) {
    let (mut max_len, mut head_max, mut temps) = (1024usize, 256usize, vec![1.0, 1.0, 1.0]);
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(n) = v.get("max_len").and_then(|x| x.as_u64()) {
                max_len = n as usize;
            }
            if let Some(n) = v.get("head_max_len").and_then(|x| x.as_u64()) {
                head_max = n as usize;
            }
            if let Some(t) = v.get("temperature").and_then(|x| x.as_array()) {
                let ts: Vec<f32> = t.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect();
                if ts.len() == 3 {
                    temps = ts;
                }
            }
        }
    }
    (max_len, head_max, temps)
}

fn mask_token_id(t: &Tokenizer) -> u32 {
    t.token_to_id("<mask>").unwrap_or(4)
}
fn cls_token_id(t: &Tokenizer) -> u32 {
    t.token_to_id("<bos>").unwrap_or(2)
}
fn sep_token_id(t: &Tokenizer) -> u32 {
    t.token_to_id("<eos>").unwrap_or(1)
}
