// iPhone Duo / foldables: align the camera|HUD split with the hinge.
// Safari may not expose viewport segments; the default 50/50 split already
// lands on the fold of a book-style foldable. When the browser does report
// segments (Viewport Segments API / Device Posture API) we use exact values.

export function watchFold(onChange) {
  const apply = () => {
    const segs = window.viewport?.segments;
    const b = document.body;
    b.classList.remove('fold-h', 'fold-v');
    if (segs && segs.length === 2) {
      const [a, c] = segs;
      const st = document.documentElement.style;
      if (Math.abs(a.y - c.y) < 2) {
        // side by side
        st.setProperty('--seg0', `${a.width}px`);
        st.setProperty('--seg1', `${c.width}px`);
        st.setProperty('--seg-gap', `${Math.max(0, c.x - (a.x + a.width))}px`);
        b.classList.add('fold-h');
      } else {
        st.setProperty('--seg0', `${a.height}px`);
        st.setProperty('--seg1', `${c.height}px`);
        b.classList.add('fold-v');
      }
    }
    const posture = navigator.devicePosture?.type || 'continuous';
    b.dataset.posture = posture;
    onChange?.({ segments: segs?.length || 1, posture });
  };
  apply();
  window.addEventListener('resize', apply);
  navigator.devicePosture?.addEventListener?.('change', apply);
  window.viewport?.addEventListener?.('segmentschange', apply);
  return apply;
}
