import { decodeSliceBytes, type SliceRequest, type SliceResponse } from './decode';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', async (event: MessageEvent<SliceRequest>): Promise<void> => {
  const request = event.data;
  let response: SliceResponse;
  let transfer: Transferable[] = [];
  try {
    const { file, byteOffset, byteLength } = request;
    const buffer = await file.slice(byteOffset, byteOffset + byteLength).arrayBuffer();
    const decoded = decodeSliceBytes(buffer, request);
    response = decoded;
    transfer = [decoded.samples.buffer as ArrayBuffer];
  } catch (error) {
    response = {
      kind: 'error',
      index: request.index,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  scope.postMessage(response, transfer);
});
