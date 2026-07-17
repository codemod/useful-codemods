import { getService } from "./lib/service";

vi.mock("./lib/service", () => ({
  getService: vi.fn(() => "mocked"),
}));

describe("service", () => {
  it("uses the mocked service", async () => {
    const lib = await import("./lib/service");
    expect(getService()).toBe("mocked");
    expect(lib.getService()).toBe("mocked");
  });
});
