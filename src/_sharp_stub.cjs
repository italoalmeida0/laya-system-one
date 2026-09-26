// Minimal stub for the optional 'sharp' dependency (image processing).
// @huggingface/transformers imports sharp at module load but only uses it
// for image pipelines — never for tokenizers. This stub lets tokenizer-only
// use (laya-system-one) work on platforms where sharp's native binding is
// missing or broken (e.g. WSL2 ARM64 without libvips).
const noop = () => proxy;
const proxy = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : noop),
  apply: () => proxy,
});
module.exports = proxy;
module.exports.default = proxy;
