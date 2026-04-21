import { Button, Modal } from "./components";

jest.mock("./components", function () {
  return {
    Button: jest.fn(() => null),
    Modal: jest.fn(() => null),
  };
});

describe("Factory function form", () => {
  it("works", () => {
    expect(Button).toBeDefined();
    expect(Modal).toBeDefined();
  });
});
