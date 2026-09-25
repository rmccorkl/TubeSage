import { describe, expect, it } from "vitest";
import { describeShape } from "../lib/shape.mjs";

describe("describeShape", () => {
  it("never leaks string content", () => {
    const shape = describeShape({ secret: "sk-super-secret-value", nested: { text: "leak me" } });
    expect(JSON.stringify(shape)).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(shape)).not.toContain("leak me");
  });

  it("maps primitives to their typeof name", () => {
    expect(describeShape("x")).toBe("string");
    expect(describeShape(1)).toBe("number");
    expect(describeShape(true)).toBe("boolean");
    expect(describeShape(undefined)).toBe("undefined");
  });

  it("maps null to the literal string null", () => {
    expect(describeShape(null)).toBe("null");
  });

  it("describes an array by its length and the shape of its first element", () => {
    expect(describeShape(["a", "b", "c"])).toEqual({ array: "string", length: 3 });
    expect(describeShape([])).toEqual({ array: null, length: 0 });
    expect(describeShape([1, "not used"])).toEqual({ array: "number", length: 2 });
  });

  it("describes an object by the shape of each of its values", () => {
    expect(describeShape({ model: "x", usage: { cost: 1 } })).toEqual({
      object: { model: "string", usage: { object: { cost: "number" } } },
    });
  });
});
