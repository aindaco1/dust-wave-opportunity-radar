class TestFixedLengthStream extends TransformStream<ArrayBuffer | ArrayBufferView, Uint8Array> {
  constructor(expectedLength: number | bigint) {
    const expected = Number(expectedLength);
    let written = 0;
    super({
      transform(chunk, controller) {
        const bytes = chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        written += bytes.byteLength;
        if (written > expected) throw new TypeError("FixedLengthStream received too many bytes");
        controller.enqueue(bytes);
      },
      flush() {
        if (written !== expected) throw new TypeError("FixedLengthStream received too few bytes");
      }
    });
  }
}

if (typeof FixedLengthStream === "undefined") {
  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    value: TestFixedLengthStream,
    writable: true
  });
}
