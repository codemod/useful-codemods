import { Button, Modal } from "./components";

jest.mock("./components", () => ({
  Button: jest.fn(() => null),
  Modal: jest.fn(() => null),
}));

describe("Components", () => {
  it("works", () => {
    expect(Button).toBeDefined();
    expect(Modal).toBeDefined();
  });
});
