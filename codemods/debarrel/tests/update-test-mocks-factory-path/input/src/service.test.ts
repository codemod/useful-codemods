import { getService } from "./lib";

vi.mock("./lib", () => ({
  getService: vi.fn(() => "mocked"),
}));

describe("service", () => {
  it("uses the mocked service", async () => {
    const lib = await import("./lib");
    expect(getService()).toBe("mocked");
    expect(lib.getService()).toBe("mocked");
  });
});
