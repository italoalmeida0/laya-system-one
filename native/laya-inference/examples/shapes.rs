use laya_inference::LayaModel;
fn main() {
    // REAL ids parity: ids from C:/temp/real_ids.json (len 25, markers [8,12])
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("C:/temp/real_ids.json").unwrap()).unwrap();
    let ids: Vec<i64> = j["ids"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    let mp: Vec<i64> = j["markers"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    println!("ids len {} markers {:?}", ids.len(), mp);
    let m = LayaModel::load("../../models/model.onnx").expect("load");
    let t0 = std::time::Instant::now();
    match m.infer(&ids, ids.len(), &mp, 0) {
        Ok(l) => println!("tract-REAL {:?} [{}]  (ORT-REAL: -1.076921,1.059853)", t0.elapsed(), l.iter().map(|v| format!("{v:.6}")).collect::<Vec<_>>().join(",")),
        Err(e) => println!("FAIL: {}", format!("{e:?}").chars().take(250).collect::<String>()),
    }
}
