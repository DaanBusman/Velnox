/**
 * A slow, soft movement behind the signed-in screens, when the viewer asked for
 * it (Settings). Three blurred shapes drifting on long loops, coloured from the
 * theme's own tokens so they follow light and dark without a line of script.
 * Behind everything, never in the way of a click, hidden from assistive
 * technology, and still for anyone whose system asks for reduced motion.
 */
export function MotionBackground() {
  return (
    <div aria-hidden className="velnox-motion-bg">
      <span className="velnox-orb velnox-orb-1" />
      <span className="velnox-orb velnox-orb-2" />
      <span className="velnox-orb velnox-orb-3" />
    </div>
  );
}
