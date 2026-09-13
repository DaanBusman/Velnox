import Image from 'next/image';
import clsx from 'clsx';
import { UPSTREAM_PRODUCT_NAME } from '@velnox/shared';
import mark from '@/assets/velnox-mark.png';

/**
 * The Velnox mark — shown only when this installation is still Velnox.
 *
 * The product name comes from `system_settings.product_name` so an MSP can
 * present the console to its customers as its own, and TRADEMARK.md asks that a
 * fork or a rebranded deployment drop the name *and the logo*. Shipping the logo
 * unconditionally would put the project in the position of asking others to do
 * something the software itself makes impossible.
 *
 * So a rebranded installation gets a plain initial instead. It is not a licence
 * control — nothing stops someone editing this file, and the AGPLv3 says they
 * may — it is the product not contradicting its own policy.
 *
 * The attribution notice on Settings > About is the separate thing that does
 * survive a rebrand, and it is required rather than asked for (AGPLv3 section
 * 7(b), see NOTICE).
 */
export function ProductMark({
  product,
  size = 28,
  className,
}: {
  product: string;
  size?: number;
  className?: string;
}) {
  const isUpstream = product.trim() === UPSTREAM_PRODUCT_NAME;

  if (isUpstream) {
    return (
      <Image
        /*
         * A static import, not `/velnox-mark.png` from `public/`.
         *
         * The first attempt put it in `public/` and it rendered as a broken
         * image in the container while working perfectly in development: Next's
         * standalone output does not include `public/`, and the web Dockerfile
         * copies `.next/standalone` and `.next/static` and nothing else. A
         * statically imported image is emitted into `.next/static/media`, which
         * is already on that list — so it ships by the same route as the CSS and
         * cannot be forgotten separately.
         */
        src={mark}
        alt=""
        aria-hidden
        width={size}
        height={size}
        /*
         * Unoptimized on purpose. The source is 128px and is rendered at 28 or
         * 56, so the optimizer would save nothing worth having — and it would
         * add a runtime dependency on sharp inside the standalone bundle for one
         * decorative icon.
         */
        unoptimized
        // The mark carries its own dark ground, so it needs no plate behind it
        // and reads the same in both themes.
        className={clsx('shrink-0 rounded-md shadow-raised', className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={clsx(
        'grid shrink-0 place-items-center rounded-md font-bold',
        'bg-accent text-accent-contrast shadow-raised velnox-lit',
        size >= 40 ? 'text-lg' : 'text-[12px]',
        className,
      )}
    >
      {product.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
