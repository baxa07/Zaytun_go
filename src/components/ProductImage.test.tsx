import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MenuCard } from "../App";
import { ProductImage, isHttpsImageUrl } from "./ProductImage";

const item = {
  id: "test-item",
  categoryId: "test-category",
  name: "Sinov taomi",
  description: "Sinov tavsifi",
  price: 25000,
  image: "",
  available: true,
  packagingRequired: false,
  packagingUnitPrice: 0,
  packagingCapacity: null,
};

describe("ProductImage", () => {
  it("renders a valid HTTPS source as a lazy image with the product-name alt", () => {
    const source = "https://images.example.test/product.jpg";
    const { container } = render(<ProductImage image={source} name={item.name} />);
    const image = screen.getByRole("img", { name: item.name });
    expect(image.getAttribute("src")).toBe(source);
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(container.textContent).not.toContain(source);
  });

  it("shows the branded placeholder for an empty image", () => {
    render(<ProductImage image="" name={item.name} />);
    expect(screen.getByLabelText(`${item.name} rasmi mavjud emas`).textContent).toBe("ZG");
  });

  it("replaces a failed image with the placeholder without another image request", () => {
    render(<ProductImage image="https://images.example.test/broken.jpg" name={item.name} />);
    fireEvent.error(screen.getByRole("img", { name: item.name }));
    expect(screen.queryByRole("img", { name: item.name })).toBeNull();
    expect(screen.getByLabelText(`${item.name} rasmi mavjud emas`)).toBeTruthy();
  });

  it("preserves intentional emoji artwork but rejects raw or unsafe URL text", () => {
    const { rerender } = render(<ProductImage image="🔥" name={item.name} />);
    expect(screen.getByRole("img", { name: item.name }).textContent).toBe("🔥");
    rerender(<ProductImage image="http://example.test/raw.jpg" name={item.name} />);
    expect(screen.queryByText("http://example.test/raw.jpg")).toBeNull();
    expect(screen.getByLabelText(`${item.name} rasmi mavjud emas`)).toBeTruthy();
    expect(isHttpsImageUrl("https://example.test/image.jpg")).toBe(true);
    expect(isHttpsImageUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("MenuCard without an image", () => {
  it("keeps product content and selection action usable", () => {
    render(<MemoryRouter><MenuCard item={item} /></MemoryRouter>);
    expect(screen.getByText(item.name)).toBeTruthy();
    expect(screen.getByText(item.description)).toBeTruthy();
    expect(screen.getByText(/25.*000 so‘m/)).toBeTruthy();
    expect(screen.getByRole("link", { name: `${item.name} tanlash` }).getAttribute("href")).toBe(`/menu/${item.id}`);
  });
});
