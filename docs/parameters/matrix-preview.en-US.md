# Matrix Structure and File Size

For Anima training, open **Structure preview** under **Training network module** to inspect the adapter matrices constructed by the current settings. The entry also shows the estimated weight-file size, making it easier to compare rank, algorithms, and training scopes.

<!-- doc-anchor: overview -->
## Inspect actual modules

![LoKr matrix structure and file-size estimate in the ComfyUI theme](../images/shape-preview.en-US.png)

The preview uses the training network constructors with fake tensors. It does not load base-model weights or start training. It currently supports native Anima LoRA / LoHa / LoKr and LyCORIS LoCon / LoHa / LoKr.

Use the structure preview to check which matrices a configuration actually creates, which settings take effect, and the estimated saved file size.

| Preview item | Meaning |
| --- | --- |
| Input and output dimensions | Feature counts of the original layer; they need not match |
| Saved matrix shapes | Tensors trained and saved by the adapter, not the full base-model weights |
| Rank, Alpha, and scale | Values actually used by the selected module, not merely entered in the form |
| Parameter count | Adapter size; similar counts do not imply equivalent parameterizations |
| File size | An estimate based on saved tensors, precision, and packaging, not training memory |

<!-- doc-anchor: file-size -->
## How file size is estimated

The estimate counts the tensors actually saved by the adapter at the selected save precision, then adds the safetensors tensor-index header. `fp16` / `bf16` use 2 bytes per element and `float` uses 4. Saved non-trainable tensors such as alpha are included, so file size is not simply the trainable parameter count multiplied by bytes per element.

This is an estimate of the **LoRA weight file**, excluding the base model, optimizer state, training caches, and sample images. It is not a VRAM estimate. Training metadata adds more bytes, and other save formats can have different container overhead. The final file is authoritative.

To compare settings, hold the algorithm and scope fixed while changing rank, or hold rank fixed while comparing scopes. Algorithms such as LoKr can switch between full matrices and low-rank factors, so file size does not always grow linearly with rank. Unsupported or failed constructions display an estimation error instead of falling back to a generic formula.

For LoKr, watch for transitions from low-rank factors to full matrices. File size need not vary linearly across that transition. After changing a setting, checking the resulting matrices is more reliable than inferring behavior from the parameter name alone.

The safetensors estimate includes saved tensors and their index header. Training metadata and other save formats add overhead, so the saved file is the final reference.
