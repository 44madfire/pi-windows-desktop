import type { PiRpcDataChunk } from "./transport.ts";

/**
 * Incremental LF-delimited JSON framing.
 *
 * Only LF ends a record. A trailing CR is accepted as the optional CRLF
 * compatibility case, while Unicode line separators remain part of JSON.
 */
export class PiJsonlBuffer {
  private bufferedText = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: PiRpcDataChunk): string[] {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    this.bufferedText += this.decoder.decode(bytes, { stream: true });

    const lines: string[] = [];
    let newlineIndex = this.bufferedText.indexOf("\n");

    while (newlineIndex >= 0) {
      let line = this.bufferedText.slice(0, newlineIndex);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      lines.push(line);
      this.bufferedText = this.bufferedText.slice(newlineIndex + 1);
      newlineIndex = this.bufferedText.indexOf("\n");
    }

    return lines;
  }

  /**
   * Flush the decoder and return an unterminated record, if any.
   * Callers should treat a returned value as a protocol error: JSONL records
   * are not complete until an LF delimiter has been received.
   */
  finish(): string | undefined {
    this.bufferedText += this.decoder.decode();

    if (this.bufferedText.length === 0) {
      return undefined;
    }

    const partial = this.bufferedText;
    this.bufferedText = "";
    return partial;
  }

  reset(): void {
    this.bufferedText = "";
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }
}
