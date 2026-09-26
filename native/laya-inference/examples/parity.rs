use laya_inference::LayaModel;
fn main() {
    let m = LayaModel::load("../../models/model.onnx").expect("load");
    let t0 = std::time::Instant::now();
    // warmup
    let ids = vec![10i64; 33];
    let mp = vec![5i64, 12];
    let l = m.infer(&ids, 33, &mp, 0).expect("infer");
    println!("warmup {:?} logits={:?}", t0.elapsed(), l);
    for (s, nm) in [(33usize, 2usize), (63, 3)] {
        let ids = vec![10i64; s];
        let mp: Vec<i64> = vec![5, 12, 19][..nm].to_vec();
        let t = std::time::Instant::now();
        let l = m.infer(&ids, s, &mp, 0).expect("infer");
        println!("S={s} M={nm} {:?} logits=[{}]", t.elapsed(), l.iter().map(|v| format!("{v:.6}")).collect::<Vec<_>>().join(","));
    }
}
