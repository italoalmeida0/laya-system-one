//! Prompt building + answer decoding: 1:1 port of src/tokenizer.js
//! (buildSequence/renderOptions) and src/agent.js (softmax/decode).

use crate::schema::QDef;
use std::collections::{BTreeMap, HashMap};
use tokenizers::Tokenizer;

pub struct InternalQ {
    pub t: String, // choice | score | noul
    pub ins: String,
    /// choice: ordered (key, text-or-null); score: levels; noul: (false_t, true_t)
    pub opts: Vec<String>,
    pub keys: Vec<String>,
    pub legend: Option<BTreeMap<String, String>>,
}

impl InternalQ {
    pub fn from_def(_qid: &str, qdef: &QDef) -> Self {
        let t = qdef.qtype.clone();
        let ins = match &qdef.instructions {
            serde_json::Value::String(s) => s.clone(),
            v => v.to_string(),
        };
        let crit = qdef.criteria.clone().unwrap_or(serde_json::Value::Null);
        if t == "choice" {
            let mut keys = vec![];
            let mut opts = vec![];
            if let Some(map) = crit.as_object() {
                for (k, v) in map {
                    keys.push(k.clone());
                    let text = match v {
                        serde_json::Value::Null => k.clone(),
                        serde_json::Value::String(s) if s.is_empty() => k.clone(),
                        serde_json::Value::String(s) => format!("{k}: {s}"),
                        v => format!("{k}: {v}"),
                    };
                    opts.push(text);
                }
            } else if let Some(arr) = crit.as_array() {
                for c in arr {
                    let label = match c {
                        serde_json::Value::String(s) => s.clone(),
                        v => v.to_string(),
                    };
                    keys.push(label.clone());
                    opts.push(label);
                }
            }
            Self { t, ins, opts, keys, legend: None }
        } else if t == "score" {
            let mut opts = vec![];
            let mut legend = BTreeMap::new();
            if let Some(arr) = crit.as_array() {
                for (i, c) in arr.iter().enumerate() {
                    let label = match c {
                        serde_json::Value::String(s) => s.clone(),
                        v => v.to_string(),
                    };
                    legend.insert(i.to_string(), label.clone());
                    opts.push(format!("level {i}: {label}"));
                }
            } else if let Some(map) = crit.as_object() {
                for (k, v) in map {
                    let label = match v {
                        serde_json::Value::String(s) => s.clone(),
                        v => v.to_string(),
                    };
                    legend.insert(k.clone(), label.clone());
                    opts.push(format!("level {k}: {label}"));
                }
            }
            Self { t, ins, opts, keys: vec![], legend: Some(legend) }
        } else {
            // noul
            let (f, tr) = match &crit {
                serde_json::Value::Object(m) => (
                    m.get("false").map(|v| str_of(v)).unwrap_or_else(|| "no, the statement does not hold".into()),
                    m.get("true").map(|v| str_of(v)).unwrap_or_else(|| "yes, the statement holds".into()),
                ),
                _ => (
                    "no, the statement does not hold".into(),
                    "yes, the statement holds".into(),
                ),
            };
            Self {
                t,
                ins,
                opts: vec![format!("false: {f}"), format!("true: {tr}")],
                keys: vec![],
                legend: None,
            }
        }
    }
}

fn str_of(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

fn serialize_state(state: &serde_json::Value) -> String {
    match state {
        serde_json::Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

pub struct PromptBuilder {
    tok: Tokenizer,
    mask_id: u32,
    cls_id: u32,
    sep_id: u32,
    cache: HashMap<String, Vec<u32>>,
}

impl PromptBuilder {
    pub fn new(tok: Tokenizer, mask_id: u32, cls_id: u32, sep_id: u32) -> Self {
        Self { tok, mask_id, cls_id, sep_id, cache: HashMap::new() }
    }

    fn encode_cached(&mut self, text: &str) -> Vec<u32> {
        if let Some(hit) = self.cache.get(text) {
            return hit.clone();
        }
        let ids: Vec<u32> = self
            .tok
            .encode(text, false)
            .map(|e| e.get_ids().to_vec())
            .unwrap_or_default();
        if self.cache.len() > 2000 {
            self.cache.clear();
        }
        self.cache.insert(text.to_string(), ids.clone());
        ids
    }

    /// Returns (input_ids as u32, marker positions).
    pub fn build(
        &mut self,
        state: &serde_json::Value,
        q: &InternalQ,
        max_len: usize,
        head_max_len: usize,
    ) -> (Vec<u32>, Vec<u32>) {
        let mask_tok = "<mask>";
        let ins = q.ins.replace(mask_tok, " ");
        let mut head_ids = self.encode_cached(&format!("{} question: {ins}", q.t));

        let mut opt_ids: Vec<Vec<u32>> = vec![];
        for opt in &q.opts {
            let raw = self.encode_cached(&format!(" {}", opt.replace(mask_tok, " ")));
            let mut o = vec![self.mask_id];
            o.extend(raw.iter().take(48).copied());
            opt_ids.push(o);
        }

        let mut opt_budget: isize =
            head_max_len as isize - opt_ids.iter().map(|o| o.len() as isize).sum::<isize>();
        if opt_budget < 16 {
            let per = std::cmp::max(
                4,
                (head_max_len as isize - 16) / std::cmp::max(1, opt_ids.len() as isize),
            ) as usize;
            for o in opt_ids.iter_mut() {
                o.truncate(per);
            }
            opt_budget =
                head_max_len as isize - opt_ids.iter().map(|o| o.len() as isize).sum::<isize>();
        }

        head_ids.truncate(std::cmp::max(8, opt_budget as usize));
        let mut ids = vec![self.cls_id];
        ids.extend(head_ids);
        ids.push(self.sep_id);
        let mut markers: Vec<u32> = vec![];
        for o in &opt_ids {
            markers.push(ids.len() as u32);
            ids.extend(o.iter().copied());
        }
        ids.push(self.sep_id);

        let room = max_len.saturating_sub(ids.len() + 1);
        let state_str = serialize_state(state).replace(mask_tok, " ");
        let st = self
            .tok
            .encode(state_str.as_str(), false)
            .map(|e| e.get_ids().to_vec())
            .unwrap_or_default();
        ids.extend(st.iter().take(room).copied());
        ids.push(self.sep_id);

        ids.truncate(max_len);
        markers.retain(|&m| (m as usize) < max_len);
        (ids, markers)
    }
}

pub fn softmax(logits: &[f32], temp: f32) -> Vec<f32> {
    let t = if temp <= 0.0 { 1.0 } else { temp };
    let scaled: Vec<f32> = logits.iter().map(|x| x / t).collect();
    let max = scaled.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = scaled.iter().map(|x| (x - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    exps.iter().map(|x| x / sum).collect()
}

fn confidence(probs: &[f32], k: usize) -> f32 {
    if k <= 1 {
        return 1.0;
    }
    let uniform = 1.0 / k as f32;
    let mut kl = 0.0f32;
    for &p in probs {
        let pc = p.max(1e-9);
        kl += pc * (pc / uniform).ln();
    }
    let max_kl = (k as f32).ln();
    (kl / max_kl).clamp(0.0, 1.0)
}

fn r4(x: f32) -> f32 {
    (x * 10000.0).round() / 10000.0
}

/// Decode logits into a Jev-compatible answer object.
pub fn decode(q: &InternalQ, qdef: &QDef, logits: &[f32], temp: f32) -> serde_json::Value {
    let k = logits.len();
    let probs = softmax(logits, temp);
    let conf = r4(confidence(&probs, k));
    if q.t == "choice" {
        let mut max_idx = 0;
        let mut max_p = -1.0f32;
        let mut map = serde_json::Map::new();
        for (i, key) in q.keys.iter().enumerate() {
            let p = r4(*probs.get(i).unwrap_or(&0.0));
            map.insert(key.clone(), p.into());
            if p > max_p {
                max_p = p;
                max_idx = i;
            }
        }
        serde_json::json!({
            "type": "choice",
            "choice": q.keys.get(max_idx).cloned().unwrap_or_default(),
            "probabilities": map,
            "confidence": conf,
        })
    } else if q.t == "score" {
        let mut expected = 0.0f32;
        let mut map = serde_json::Map::new();
        for i in 0..k {
            let p = r4(*probs.get(i).unwrap_or(&0.0));
            map.insert(i.to_string(), p.into());
            expected += i as f32 * p;
        }
        let legend = q.legend.clone().unwrap_or_default();
        serde_json::json!({
            "type": "score",
            "score": r4(expected),
            "legend": legend,
            "probabilities": map,
            "confidence": conf,
        })
    } else {
        let p_true = probs.get(1).copied().unwrap_or(0.0);
        let noul = r4(p_true);
        let mut ans = serde_json::json!({
            "type": "noul",
            "noul": noul,
            "confidence": r4(p_true.max(1.0 - p_true)),
        });
        if let Some(th) = qdef.threshold {
            ans["decision"] = (p_true >= th as f32).into();
            ans["threshold"] = th.into();
        }
        ans
    }
}
