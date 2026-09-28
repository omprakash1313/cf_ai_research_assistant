import { createWorkersAI } from "workers-ai-provider";

/**
 * Workers AI provider with a fix for streaming.
 *
 * When streaming, Llama 3.3 on Workers AI sends every chunk twice over: once
 * in OpenAI style (`choices[0].delta.content` / `.tool_calls`) and once in
 * the legacy top-level `response` / `tool_calls` fields. workers-ai-provider
 * (3.x and 4.0) parses both, so:
 *  - every text token is emitted twice ("HelloHello  worldworld")
 *  - tool-call arguments get corrupted, so tools receive `{}` and fail
 * This wrapper drops the legacy copies from any chunk that has an
 * OpenAI-style delta.
 */
export function workersAI(binding: Ai) {
  const patched = new Proxy(binding, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<Ai["run"]>) => {
        const result: unknown = await target.run(...args);
        return result instanceof ReadableStream
          ? result.pipeThrough(dedupeToolCallStream())
          : result;
      };
    }
  });
  return createWorkersAI({ binding: patched });
}

function dedupeToolCallStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const fixLine = (line: string) => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    try {
      const chunk = JSON.parse(payload);
      if (
        chunk?.choices?.[0]?.delta &&
        ("response" in chunk || "tool_calls" in chunk)
      ) {
        delete chunk.response;
        delete chunk.tool_calls;
        return `data: ${JSON.stringify(chunk)}`;
      }
    } catch {
      // Not JSON: pass through untouched.
    }
    return line;
  };

  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the incomplete last line
      if (lines.length > 0) {
        controller.enqueue(
          encoder.encode(lines.map(fixLine).join("\n") + "\n")
        );
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(fixLine(buffer)));
    }
  });
}
