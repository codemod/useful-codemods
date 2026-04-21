import { Button } from "./components/Button";
import { Modal } from "./components/Modal";

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
