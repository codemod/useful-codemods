import { Button } from "./components/Button";

jest.mock("./components/Button");

describe("Button", () => {
  it("renders", () => {
    expect(Button).toBeDefined();
  });
});
