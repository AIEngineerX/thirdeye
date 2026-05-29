import { describe, expect, test } from "bun:test";
import { sortRows } from "./DataTable";

const rows = [{ a: 3 }, { a: 1 }, { a: null }, { a: 2 }];

describe("sortRows", () => {
  test("desc puts nulls last", () => {
    expect(sortRows(rows, "a", "desc").map((r) => r.a)).toEqual([3, 2, 1, null]);
  });
  test("asc puts nulls last", () => {
    expect(sortRows(rows, "a", "asc").map((r) => r.a)).toEqual([1, 2, 3, null]);
  });
  test("does not mutate input", () => {
    const copy = [...rows];
    sortRows(rows, "a", "asc");
    expect(rows).toEqual(copy);
  });
});
