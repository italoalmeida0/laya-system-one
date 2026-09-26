//! laya-inference: pure-Rust inference core for laya-system-one.
//!
//! Loads the mmBERT-based RL-agent ONNX model with `tract` (no ONNX Runtime,
//! no C++ shared libs, no WASM backend roulette) and exposes a single
//! batch-1 `infer` function:
//!
//!   inputs:  input_ids [1,S] i64, attention_mask [1,S] i64,
//!            marker_pos [1,M] i64, marker_mask [1,M] bool, qtype [1] i64
//!   output:  logits [1,M] f32
//!
//! The same core compiles to:
//! - `cdylib` + napi (`--features napi`) → Node.js / Bun (Windows/macOS/Linux)
//! - `staticlib` via C-ABI (`laya_*` extern fns) → `bun:ffi` (no napi needed)
//! - `wasm32-unknown-unknown` via wasm-bindgen (browser path, future)

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::anyhow;
use tract_hir::prelude::*;
use tract_onnx::prelude::*;

/// Rewrite symbolic dim_params to concrete values in raw ONNX bytes.
/// Tract 0.23 cannot analyse this graph symbolically (GatherND rotary
/// shape rule), but optimizes cleanly once dims are concrete.
/// Rewrites graph input/output/value_info dims (1227 spots in this model).
fn patch_dim_params(raw: &[u8], s: usize, m: usize) -> TractResult<Vec<u8>> {
    use tract_onnx::pb as onnx_pb;
    let model: onnx_pb::ModelProto = prost::Message::decode(raw)?;
    let mut model = model;
    use onnx_pb::tensor_shape_proto::dimension::Value as V;
    let mut fix = |dims: &mut Vec<onnx_pb::tensor_shape_proto::Dimension>| {
        for d in dims.iter_mut() {
            if let Some(V::DimParam(p)) = &mut d.value {
                if p == "seq_len" {
                    *p = s.to_string();
                }
                if p == "num_markers" {
                    *p = m.to_string();
                }
            }
        }
    };
    if let Some(g) = model.graph.as_mut() {
        for vi in g
            .input
            .iter_mut()
            .chain(g.output.iter_mut())
            .chain(g.value_info.iter_mut())
        {
            if let Some(t) = vi.r#type.as_mut() {
                if let Some(onnx_pb::type_proto::Value::TensorType(tt)) = &mut t.value {
                    if let Some(sh) = tt.shape.as_mut() {
                        fix(&mut sh.dim);
                    }
                }
            }
        }
    }
    let mut buf = Vec::with_capacity(raw.len());
    prost::Message::encode(&model, &mut buf)?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Model handle
// ---------------------------------------------------------------------------

type Runnable = RunnableModel<TypedFact, Box<dyn TypedOp>>;
type Typed = Graph<TypedFact, Box<dyn TypedOp>>;

pub struct LayaModel {
    path: String,
    #[allow(dead_code)]
    input_names: Vec<String>,
    // Specialized runnables per (S, M): tract needs concrete dims to
    // infer shapes through GatherND etc. Prompts reuse the same few
    // shapes, so this cache stays tiny.
    cache: Mutex<Vec<((usize, usize), Arc<Runnable>)>>,
    /// On wasm, the model bytes travel with the instance (no fs).
    /// `None` on native (model re-parsed from `path` per shape).
    bytes: Option<Vec<u8>>,
}

impl LayaModel {
    pub fn load(path: impl AsRef<Path>) -> TractResult<Arc<Self>> {
        let p = path.as_ref().to_string_lossy().to_string();
        // Keep the INFERENCE model unoptimized: into_optimized() fails on
        // this graph (GatherND rotary-embedding shape rule needs concrete
        // dims: `1,1,1,seq_len has no 4-th dimension`). We run the
        // unoptimized graph but with SYMBOLS concretized per shape —
        // into_runnable() on the raw inference model works, it just needs
        // `run` to receive tensors whose dims match... except it checks
        // against symbolic facts and rejects concrete ones. So instead:
        // concretize symbols on a CLONE via SymbolValues, then optimize.
        let base = tract_onnx::onnx().model_for_path(&path)?;
        let input_names: Vec<String> = base
            .input_outlets()?
            .iter()
            .map(|o| base.node(o.node).name.to_string())
            .collect();
        Ok(Arc::new(LayaModel {
            path: p,
            input_names,
            cache: Mutex::new(Vec::new()),
            bytes: None,
        }))
    }

    /// Parse the base INFERENCE model (never pre-optimized: the optimizer
    /// itself chokes on the symbolic GatherND).
    fn base_inference(&self) -> TractResult<tract_onnx::prelude::InferenceModel> {
        if let Some(b) = &self.bytes {
            Ok(tract_onnx::onnx().model_for_read(&mut &b[..])?)
        } else {
            Ok(tract_onnx::onnx().model_for_path(&self.path)?)
        }
    }

    fn runnable_for(&self, s: usize, m: usize) -> TractResult<Arc<Runnable>> {
        if let Ok(cache) = self.cache.lock() {
            if let Some((_, r)) = cache.iter().find(|(k, _)| *k == (s, m)) {
                return Ok(r.clone());
            }
        }
        // PROTO PATCH (proven: PATCHED OPTIMIZE-OK): rewrite dim_params
        // seq_len/num_markers to concrete values in the raw ONNX bytes,
        // then parse + optimize. Tract's analyser cannot resolve this
        // graph's symbolic GatherND/Range (rotary embeddings), but with
        // concrete dims every rule unifies. Per-shape specialized
        // runnables are cached (prompts reuse the same few shapes).
        let raw: &[u8] = if let Some(b) = &self.bytes {
            b
        } else {
            // native path: read file once per new shape (shapes are few;
            // the parsed+runnable result is cached).
            &std::fs::read(&self.path)?
        };
        let patched = patch_dim_params(raw, s, m)?;
        let runnable = tract_core::plan::SimplePlan::new(
            tract_onnx::onnx()
                .model_for_read(&mut &patched[..])?
                .into_optimized()?,
        )?;
        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() > 16 {
                cache.clear();
            }
            cache.push(((s, m), runnable.clone()));
        }
        Ok(runnable)
    }

    /// Run one inference. Returns M logits (f32).
    pub fn infer(
        &self,
        input_ids: &[i64],
        seq_len: usize,
        attention_mask: &[i64],
        marker_pos: &[i64],
        marker_mask: &[bool],
        qtype: i64,
    ) -> TractResult<Vec<f32>> {
        let num_markers = marker_pos.len();
        let s = seq_len;

        let input_ids_t: Tensor = tract_ndarray::Array2::from_shape_vec(
            (1, s),
            input_ids.to_vec(),
        )?
        .into();
        // attention_mask / marker_mask come from the caller: padding must be
        // masked out (0 / false) so a padded shape gives the same answer as
        // the unpadded one. That is what lets the wasm backend reuse ONE
        // specialized plan instead of one per input length (each plan holds
        // its own copy of the weights, and wasm32 dies past ~4 GB).
        let attn_t: Tensor = tract_ndarray::Array2::from_shape_vec(
            (1, s),
            attention_mask.to_vec(),
        )?
        .into();
        let marker_pos_t: Tensor = tract_ndarray::Array2::from_shape_vec(
            (1, num_markers),
            marker_pos.to_vec(),
        )?
        .into();
        let marker_mask_t: Tensor = tract_ndarray::Array2::from_shape_vec(
            (1, num_markers),
            marker_mask.to_vec(),
        )?
        .into();
        let qtype_t: Tensor =
            tract_ndarray::Array1::from_vec(vec![qtype]).into();

        let runnable = self.runnable_for(s, num_markers)?;
        let out = runnable.run(tvec![
            input_ids_t.into(),
            attn_t.into(),
            marker_pos_t.into(),
            marker_mask_t.into(),
            qtype_t.into(),
        ])?;
        // 0.23: TValue wraps Arc<Tensor>; read flat f32 logits.
        let t = out[0]
            .as_arc_tensor()
            .ok_or_else(|| anyhow!("laya: empty output tensor"))?;
        Ok(t.try_as_plain_ram()?.as_slice::<f32>()?.to_vec())
    }
}

// ---------------------------------------------------------------------------
// Global registry (one model per path; shared across threads)
// ---------------------------------------------------------------------------

static REGISTRY: OnceLock<Mutex<Vec<(String, Arc<LayaModel>)>>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<(String, Arc<LayaModel>)>> {
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Load (or reuse) a model. Returns its handle id.
pub fn load_model(path: &str) -> Result<usize, String> {
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    if let Some((i, _)) = reg.iter().enumerate().find(|(_, (p, _))| p == path) {
        return Ok(i);
    }
    let m = LayaModel::load(path).map_err(|e| format!("tract load: {e:?}"))?;
    reg.push((path.to_string(), m));
    Ok(reg.len() - 1)
}

fn with_model<R>(id: usize, f: impl FnOnce(&LayaModel) -> R) -> Result<R, String> {
    let reg = registry().lock().map_err(|e| e.to_string())?;
    let (_, m) = reg.get(id).ok_or_else(|| format!("bad model id {id}"))?;
    Ok(f(m))
}

/// Infer through a loaded model. Errors are strings (FFI-friendly).
pub fn infer(
    id: usize,
    input_ids: &[i64],
    seq_len: usize,
    attention_mask: &[i64],
    marker_pos: &[i64],
    marker_mask: &[bool],
    qtype: i64,
) -> Result<Vec<f32>, String> {
    with_model(id, |m| {
        m.infer(input_ids, seq_len, attention_mask, marker_pos, marker_mask, qtype)
            .map_err(|e| format!("tract infer: {e:?}"))
    })?
}

// ---------------------------------------------------------------------------
// C ABI (stable for bun:ffi / other runtimes, no napi dependency)
// ---------------------------------------------------------------------------

/// Load model at `path` (nul-terminated UTF-8). Returns handle id or -1.
/// On error, writes message into `err_buf` (up to err_cap bytes).
#[no_mangle]
pub extern "C" fn laya_load(path_ptr: *const u8, path_len: usize) -> i64 {
    if path_ptr.is_null() {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(path_ptr, path_len) };
    let path = match std::str::from_utf8(bytes) {
        Ok(p) => p,
        Err(_) => return -1,
    };
    match load_model(path) {
        Ok(id) => id as i64,
        Err(e) => {
            eprintln!("[laya-inference] load failed: {e}");
            -1
        }
    }
}

/// Run inference. `logits_out` must hold >= num_markers f32.
/// Returns number of logits written, or negative on error.
#[no_mangle]
pub extern "C" fn laya_infer(
    id: usize,
    input_ids_ptr: *const i64,
    seq_len: usize,
    marker_pos_ptr: *const i64,
    num_markers: usize,
    qtype: i64,
    logits_out: *mut f32,
    logits_cap: usize,
) -> i64 {
    if input_ids_ptr.is_null() || marker_pos_ptr.is_null() || logits_out.is_null() {
        return -1;
    }
    if logits_cap < num_markers || seq_len == 0 || num_markers == 0 {
        return -2;
    }
    let input_ids = unsafe { std::slice::from_raw_parts(input_ids_ptr, seq_len) };
    let marker_pos =
        unsafe { std::slice::from_raw_parts(marker_pos_ptr, num_markers) };
    // The stable C ABI has no mask parameters: unpadded inputs only.
    let attention_mask = vec![1i64; seq_len];
    let marker_mask = vec![true; num_markers];
    match infer(id, input_ids, seq_len, &attention_mask, marker_pos, &marker_mask, qtype) {
        Ok(logits) => {
            let n = logits.len().min(logits_cap);
            unsafe { std::ptr::copy_nonoverlapping(logits.as_ptr(), logits_out, n) };
            n as i64
        }
        Err(e) => {
            eprintln!("[laya-inference] infer failed: {e}");
            -3
        }
    }
}

// ---------------------------------------------------------------------------
// wasm-bindgen API (wasm32-unknown-unknown, --features wasm).
// Same core, one binary for every platform: Node, Bun, browsers, WSL.
// The 309MB ONNX weights are loaded from bytes passed in by JS
// (fetch/readFile), so no fs access is needed inside wasm.
// ---------------------------------------------------------------------------
#[cfg(feature = "wasm")]
mod wasm_api {
    use super::*;
    use wasm_bindgen::prelude::*;

    /// A loaded model instance (owned bytes + specialized runnables).
    /// JS: `const m = LayaWasm.load(bytes); m.infer(ids, markers, q);`
    #[wasm_bindgen]
    pub struct LayaWasm {
        inner: Arc<LayaModel>,
    }

    #[wasm_bindgen]
    impl LayaWasm {
        /// Parse + optimize ONNX bytes. Heavy (~seconds); call once.
        /// `bytes`: full model.onnx contents.
        #[wasm_bindgen]
        pub fn load(bytes: &[u8]) -> Result<LayaWasm, JsValue> {
            // Parse only (no optimize: optimizer needs concrete dims;
            // specialization happens per shape on first infer).
            let base = tract_onnx::onnx()
                .model_for_read(&mut &bytes[..])
                .map_err(|e| JsValue::from_str(&format!("onnx parse: {e:?}")))?;
            let input_names: Vec<String> = base
                .input_outlets()
                .map_err(|e| JsValue::from_str(&format!("{e:?}")))?
                .iter()
                .map(|o| base.node(o.node).name.to_string())
                .collect();
            let _ = input_names;
            let inner = Arc::new(LayaModel {
                path: String::new(),
                input_names: vec![],
                cache: Mutex::new(Vec::new()),
                bytes: Some(bytes.to_vec()),
            });
            Ok(LayaWasm { inner })
        }

        /// Run one inference.
        ///   input_ids      i64[]   (padded)
        ///   attention_mask i64[]   (0 on padding - keeps padded == unpadded)
        ///   marker_pos     i64[]   (0 on padding)
        ///   marker_mask    u8[]    (0/1 - wasm-bindgen has no &[bool])
        /// Returns Float32Array logits (one per real marker).
        #[wasm_bindgen]
        pub fn infer(
            &self,
            input_ids: &[i64],
            attention_mask: &[i64],
            marker_pos: &[i64],
            marker_mask: &[u8],
            qtype: i64,
        ) -> Result<Vec<f32>, JsValue> {
            let s = input_ids.len();
            let mm: Vec<bool> = marker_mask.iter().map(|v| *v != 0).collect();
            self.inner
                .infer(input_ids, s, attention_mask, marker_pos, &mm, qtype)
                .map_err(|e| JsValue::from_str(&format!("{e:?}")))
        }

        /// Number of cached specialized (S, M) runnables.
        #[wasm_bindgen]
        pub fn cache_size(&self) -> usize {
            self.inner.cache.lock().map(|c| c.len()).unwrap_or(0)
        }
    }
}

// ---------------------------------------------------------------------------
// napi (Node.js; Bun can also load napi modules)
// ---------------------------------------------------------------------------

#[cfg(feature = "napi")]
mod napi_bridge {
    use super::*;
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    #[napi]
    pub fn layaLoad(path: String) -> Result<i64> {
        load_model(&path)
            .map(|id| id as i64)
            .map_err(|e| Error::from_reason(e))
    }

    #[napi]
    pub fn layaInfer(
        id: i64,
        input_ids: Vec<i64>,
        marker_pos: Vec<i64>,
        qtype: i64,
    ) -> Result<Vec<f64>> {
        let seq_len = input_ids.len();
        // napi keeps the unpadded call shape: no masks, no padding.
        let attention_mask = vec![1i64; seq_len];
        let marker_mask = vec![true; marker_pos.len()];
        infer(
            id as usize,
            &input_ids,
            seq_len,
            &attention_mask,
            &marker_pos,
            &marker_mask,
            qtype,
        )
        .map(|v| v.into_iter().map(|x| x as f64).collect())
        .map_err(|e| Error::from_reason(e))
    }
}
