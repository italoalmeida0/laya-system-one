import ortNode from 'onnxruntime-node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function benchmark(epName) {
  try {
    const sess = await ortNode.InferenceSession.create(path.join(ROOT, 'models', 'model.onnx'), {
      executionProviders: [epName]
    });

    const seqLen = 30;
    const numMarkers = 2;

    const feeds = {
      input_ids: new ortNode.Tensor('int64', new BigInt64Array(seqLen).fill(10n), [1, seqLen]),
      attention_mask: new ortNode.Tensor('int64', new BigInt64Array(seqLen).fill(1n), [1, seqLen]),
      marker_pos: new ortNode.Tensor('int64', new BigInt64Array([5n, 12n]), [1, numMarkers]),
      marker_mask: new ortNode.Tensor('bool', new Uint8Array([1, 1]), [1, numMarkers]),
      qtype: new ortNode.Tensor('int64', new BigInt64Array([0n]), [1])
    };

    // Warmup
    await sess.run(feeds);

    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      await sess.run(feeds);
    }
    const avgMs = (performance.now() - t0) / 5;
    console.log(`Backend ${epName.toUpperCase()} -> Latência média: ${avgMs.toFixed(1)} ms`);
  } catch (err) {
    console.log(`Backend ${epName.toUpperCase()} falhou: ${err.message}`);
  }
}

async function main() {
  console.log('BENCHMARK DE ACELERAÇÃO POR HARDWARE:');
  console.log('-'.repeat(50));
  await benchmark('webgpu');
  await benchmark('dml');
  await benchmark('cpu');
  console.log('-'.repeat(50));
}

main();
