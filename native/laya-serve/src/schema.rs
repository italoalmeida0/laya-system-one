//! Request/response schema: 100% TypeSafe Jev (/v1/systemone) compatible.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
pub struct InBody {
    #[serde(default)]
    pub model: Option<String>,
    pub state: serde_json::Value,
    pub questions: BTreeMap<String, QDef>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct QDef {
    #[serde(rename = "type")]
    pub qtype: String,
    #[serde(default)]
    pub instructions: serde_json::Value,
    #[serde(default)]
    pub criteria: Option<serde_json::Value>,
    #[serde(default)]
    pub threshold: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct OutBody {
    pub model: String,
    pub answers: serde_json::Value,
    pub usage: Usage,
}

#[derive(Debug, Serialize)]
pub struct Usage {
    pub input_tokens: usize,
    pub output_tokens: usize,
}
