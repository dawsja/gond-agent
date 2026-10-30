import { describe, expect, it, vi } from "vitest";
import { sendOnEnter } from "../../web/src/lib/composer-keys";

describe("message keyboard shortcuts", () => {
  it.each([
    [{}, true, true],
    [{ shiftKey: true }, false, false],
    [{ nativeEvent: { isComposing: true } }, false, false],
    [{ keyCode: 229 }, false, false],
    [{ repeat: true }, false, true],
    [{ key: "a" }, false, false],
    [{ ctrlKey: true }, true, true],
    [{ metaKey: true }, true, true],
  ])("sends only intentional Enter presses: %j", (change, sends, prevents) => {
    const send = vi.fn(), preventDefault = vi.fn();
    const event = { key: "Enter", shiftKey: false, repeat: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault, ...change };
    sendOnEnter(event, send);
    expect(send.mock.calls.length).toBe(sends ? 1 : 0);
    expect(preventDefault.mock.calls.length).toBe(prevents ? 1 : 0);
  });
});
