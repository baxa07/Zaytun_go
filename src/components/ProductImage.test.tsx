import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MenuCard } from "../App";
import type { CartItem } from "../domain";
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
const grill = {
  id: "chicken",
  categoryId: "grill",
  name: "Zaytun tovuq grili",
  description: "Marinadlangan tovuq",
  price: 68000,
  image: "",
  available: true,
  packagingRequired: true,
  packagingUnitPrice: 3000,
  packagingCapacity: 1,
  modifiers: [{ id: "spicy", name: "Achchiq", price: 0 }, { id: "sauce", name: "Qo‘shimcha sous", price: 5000 }],
};
const grillLine = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: "line-1", menuItemId: grill.id, name: grill.name, unitPrice: grill.price, quantity: 1,
  modifierIds: ["spicy"], modifierNames: ["Achchiq"], instructions: "",
  packagingRequired: true, packagingUnitPrice: 3000, packagingCapacity: 1,
  ...overrides,
});

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
    expect(isHttpsImageUrl("http://127.0.0.1:54321/storage/v1/object/public/menu-images/test.jpg")).toBe(true);
    expect(isHttpsImageUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("MenuCard without an image", () => {
  it("keeps product content and selection action usable", () => {
    render(<MemoryRouter><MenuCard item={item} /></MemoryRouter>);
    expect(screen.getByText(item.name)).toBeTruthy();
    expect(screen.getByText(item.description)).toBeTruthy();
    expect(screen.getByText(/25.*000 so‘m/)).toBeTruthy();
    expect(screen.getByRole("button", { name: `${item.name} savatga qo‘shish` })).toBeTruthy();
  });
  it("keeps an unavailable product visible but removes its add action", () => {
    render(<MemoryRouter><MenuCard item={{...item,available:false}} /></MemoryRouter>);
    expect(screen.getByText("Sotuvda emas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: `${item.name} savatga qo‘shish` })).toBeNull();
  });
});

// Product-card quantity stepper (Phase: product-card quantity controls).
// MenuCard itself stays a pure/prop-driven component -- it takes the
// authoritative `cart` array directly and resolves its own display via
// simpleCartLine/resolveProductCartLines (domain.ts), the same functions
// Menu() would use, so this exercises the real resolution logic without
// needing a full AppProvider.
describe("MenuCard quantity stepper -- simple products (unchanged behavior)", () => {
  it("1. shows the plain + when no line exists", () => {
    render(<MemoryRouter><MenuCard item={item} cart={[]} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: `${item.name} savatga qo‘shish` })).toBeTruthy();
    expect(screen.queryByTestId(`qty-stepper-${item.id}`)).toBeNull();
  });
  it("shows − 1 + once a quick-add line exists", () => {
    const line: CartItem = { id: "l1", menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: 1, modifierIds: [], modifierNames: [], instructions: "" };
    render(<MemoryRouter><MenuCard item={item} cart={[line]} /></MemoryRouter>);
    const stepper = screen.getByTestId(`qty-stepper-${item.id}`);
    expect(stepper.textContent).toContain("1");
    expect(screen.queryByRole("button", { name: `${item.name} savatga qo‘shish` })).toBeNull();
  });
  it("pressing + calls updateQuantity(id, +1) on the existing line", () => {
    const line: CartItem = { id: "l1", menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: 1, modifierIds: [], modifierNames: [], instructions: "" };
    const calls: [string, number][] = [];
    render(<MemoryRouter><MenuCard item={item} cart={[line]} updateQuantity={(id, delta) => calls.push([id, delta])} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: `${item.name} sonini oshirish` }));
    expect(calls).toEqual([["l1", 1]]);
  });
  it("pressing − calls updateQuantity(id, -1) on the existing line", () => {
    const line: CartItem = { id: "l1", menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: 2, modifierIds: [], modifierNames: [], instructions: "" };
    const calls: [string, number][] = [];
    render(<MemoryRouter><MenuCard item={item} cart={[line]} updateQuantity={(id, delta) => calls.push([id, delta])} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: `${item.name} sonini kamaytirish` }));
    expect(calls).toEqual([["l1", -1]]);
  });
  it("11. at the configured maximum, + is disabled -- simple-product behavior unchanged", () => {
    const line: CartItem = { id: "l1", menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: 50, modifierIds: [], modifierNames: [], instructions: "" };
    render(<MemoryRouter><MenuCard item={item} cart={[line]} maximumItemQuantity={50} /></MemoryRouter>);
    expect((screen.getByRole("button", { name: `${item.name} sonini oshirish` }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("11. quantity zero (line absent) renders the single + again -- mirrors updateQuantity's own zero-removes-the-line behavior", () => {
    const line: CartItem = { id: "l1", menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: 1, modifierIds: [], modifierNames: [], instructions: "" };
    const { rerender } = render(<MemoryRouter><MenuCard item={item} cart={[line]} /></MemoryRouter>);
    expect(screen.getByTestId(`qty-stepper-${item.id}`)).toBeTruthy();
    rerender(<MemoryRouter><MenuCard item={item} cart={[]} /></MemoryRouter>);
    expect(screen.queryByTestId(`qty-stepper-${item.id}`)).toBeNull();
    expect(screen.getByRole("button", { name: `${item.name} savatga qo‘shish` })).toBeTruthy();
  });
});

describe("MenuCard quantity stepper -- modifier products (Grill etc.)", () => {
  it("1. zero lines shows the plain selection + (link)", () => {
    render(<MemoryRouter><MenuCard item={grill} cart={[]} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: `${grill.name} tanlash` })).toBeTruthy();
    expect(screen.queryByTestId(`qty-stepper-${grill.id}`)).toBeNull();
    expect(screen.queryByTestId(`cart-qty-badge-${grill.id}`)).toBeNull();
  });
  it("2. exactly one distinct configured line shows − 1 + directly on the card", () => {
    render(<MemoryRouter><MenuCard item={grill} cart={[grillLine({ quantity: 1 })]} /></MemoryRouter>);
    const stepper = screen.getByTestId(`qty-stepper-${grill.id}`);
    expect(stepper.textContent).toContain("1");
    expect(screen.queryByRole("link", { name: `${grill.name} tanlash` })).toBeNull();
  });
  it("3. + increments that exact line via updateQuantity(line.id, +1)", () => {
    const calls: [string, number][] = [];
    render(<MemoryRouter><MenuCard item={grill} cart={[grillLine({ id: "line-9", quantity: 1 })]} updateQuantity={(id, delta) => calls.push([id, delta])} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: `${grill.name} sonini oshirish` }));
    expect(calls).toEqual([["line-9", 1]]);
  });
  it("4/5. − decrements that exact line via updateQuantity(line.id, -1)", () => {
    const calls: [string, number][] = [];
    render(<MemoryRouter><MenuCard item={grill} cart={[grillLine({ id: "line-9", quantity: 2 })]} updateQuantity={(id, delta) => calls.push([id, delta])} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: `${grill.name} sonini kamaytirish` }));
    expect(calls).toEqual([["line-9", -1]]);
  });
  it("5. decrementing the line to zero (caller removes it from cart, per updateQuantity's own filter) restores the selection +", () => {
    const { rerender } = render(<MemoryRouter><MenuCard item={grill} cart={[grillLine({ quantity: 1 })]} /></MemoryRouter>);
    expect(screen.getByTestId(`qty-stepper-${grill.id}`)).toBeTruthy();
    rerender(<MemoryRouter><MenuCard item={grill} cart={[]} /></MemoryRouter>);
    expect(screen.queryByTestId(`qty-stepper-${grill.id}`)).toBeNull();
    expect(screen.getByRole("link", { name: `${grill.name} tanlash` })).toBeTruthy();
  });
  it("6. incrementing/decrementing only ever passes the line id and a delta -- modifierIds, modifierNames, instructions, unitPrice and packaging fields are never touched by the card, only by updateQuantity's own quantity-only spread", () => {
    const line = grillLine({ id: "line-9", quantity: 1, modifierIds: ["spicy", "sauce"], modifierNames: ["Achchiq", "Qo‘shimcha sous"], instructions: "Sousni alohida soling", unitPrice: 73000 });
    const calls: unknown[] = [];
    render(<MemoryRouter><MenuCard item={grill} cart={[line]} updateQuantity={(...args) => calls.push(args)} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: `${grill.name} sonini oshirish` }));
    // Exactly (id, delta) -- no modifier/instruction/price data passed through the card at all.
    expect(calls).toEqual([["line-9", 1]]);
  });
  it("8. two distinct configured lines never show one ambiguous shared stepper", () => {
    const lineA = grillLine({ id: "a", modifierIds: ["spicy"], modifierNames: ["Achchiq"], quantity: 1 });
    const lineB = grillLine({ id: "b", modifierIds: ["sauce"], modifierNames: ["Qo‘shimcha sous"], quantity: 2 });
    render(<MemoryRouter><MenuCard item={grill} cart={[lineA, lineB]} /></MemoryRouter>);
    expect(screen.queryByTestId(`qty-stepper-${grill.id}`)).toBeNull();
    expect(screen.getByRole("link", { name: `${grill.name} tanlash` })).toBeTruthy();
  });
  it("9. multiple distinct lines show a total cart quantity badge instead", () => {
    const lineA = grillLine({ id: "a", modifierIds: ["spicy"], quantity: 1 });
    const lineB = grillLine({ id: "b", modifierIds: ["sauce"], quantity: 2 });
    render(<MemoryRouter><MenuCard item={grill} cart={[lineA, lineB]} /></MemoryRouter>);
    const badge = screen.getByTestId(`cart-qty-badge-${grill.id}`);
    expect(badge.textContent).toBe("Savatda 3");
  });
  it("10. the product image/name links still open the detail screen regardless of stepper state -- so a different variant can still be configured", () => {
    render(<MemoryRouter><MenuCard item={grill} cart={[grillLine({ quantity: 1 })]} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: grill.name }).getAttribute("href")).toBe(`/menu/${grill.id}`);
  });
});
