import { useEffect, useState } from "react";

export function isHttpsImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const localDevelopmentImage=url.protocol==='http:'&&(url.hostname==='127.0.0.1'||url.hostname==='localhost');
    return (url.protocol === "https:"||localDevelopmentImage) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const isIntentionalSymbol = (value: string) =>
  value.length <= 8 && /\p{Extended_Pictographic}/u.test(value);

export function ProductImage({ image, name }: { image: string; name: string }) {
  const source = image.trim();
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [source]);

  if (isHttpsImageUrl(source) && !failed) {
    return (
      <img
        className="product-image-element"
        src={source}
        alt={name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  }

  if (source && isIntentionalSymbol(source)) {
    return <span className="product-image-symbol" role="img" aria-label={name}>{source}</span>;
  }

  return <span className="product-image-placeholder" aria-label={`${name} rasmi mavjud emas`}>ZG</span>;
}
