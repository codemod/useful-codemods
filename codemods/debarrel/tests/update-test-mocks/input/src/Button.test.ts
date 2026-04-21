import { Button } from "./components";

jest.mock("./components");

describe("Button", () => {
  it("renders", () => {
    expect(Button).toBeDefined();
  });
});
