import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from 'react';

const PROTOCOL_FEATURE_ROTATION_MS = 3400;

interface ProtocolFeature {
  title: string;
  description: string;
}

interface ProtocolFeatureListProps {
  ariaLabel: string;
  features: readonly ProtocolFeature[];
}

function getPrefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export default function ProtocolFeatureList({ ariaLabel, features }: ProtocolFeatureListProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getPrefersReducedMotion);
  const [spotlight, setSpotlight] = useState({ top: 0, height: 0, ready: false });
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    if (!features.length) return;

    setActiveIndex((current) => (current >= features.length ? 0 : current));
    itemRefs.current = itemRefs.current.slice(0, features.length);
  }, [features.length]);

  const syncSpotlight = useCallback(() => {
    const activeItem = itemRefs.current[activeIndex];
    if (!activeItem) return;

    const nextTop = activeItem.offsetTop;
    const nextHeight = activeItem.offsetHeight;

    setSpotlight((current) =>
      current.ready && current.top === nextTop && current.height === nextHeight
        ? current
        : { top: nextTop, height: nextHeight, ready: true }
    );
  }, [activeIndex]);

  useLayoutEffect(() => {
    syncSpotlight();
  }, [syncSpotlight]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updatePreference);
      return () => mediaQuery.removeEventListener('change', updatePreference);
    }

    mediaQuery.addListener?.(updatePreference);
    return () => mediaQuery.removeListener?.(updatePreference);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleResize = () => syncSpotlight();
    window.addEventListener('resize', handleResize);

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => syncSpotlight());

    itemRefs.current.forEach((item) => {
      if (item) observer?.observe(item);
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      observer?.disconnect();
    };
  }, [features.length, syncSpotlight]);

  useEffect(() => {
    if (features.length < 2 || isPaused || prefersReducedMotion) return undefined;

    const rotation = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % features.length);
    }, PROTOCOL_FEATURE_ROTATION_MS);

    return () => window.clearInterval(rotation);
  }, [features.length, isPaused, prefersReducedMotion]);

  const activateFeature = useCallback((index: number) => {
    setActiveIndex(index);
    setIsPaused(true);
  }, []);

  const resumeRotation = useCallback(() => {
    setIsPaused(false);
  }, []);

  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;

    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsPaused(false);
  }, []);

  if (!features.length) return null;

  const spotlightStyle = spotlight.ready
    ? ({
        '--home-protocol-feature-top': `${spotlight.top}px`,
        '--home-protocol-feature-height': `${spotlight.height}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      className={`home-protocol-feature-list-shell ${spotlight.ready ? 'is-ready' : ''}`}
      style={spotlightStyle}
      onMouseLeave={resumeRotation}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={handleBlurCapture}
    >
      <div className="home-protocol-feature-spotlight" aria-hidden="true" />

      <ul className="home-protocol-feature-list" aria-label={ariaLabel}>
        {features.map((feature, index) => {
          const isActive = index === activeIndex;
          const descriptionId = `homeProtocolFeatureDescription${index}`;

          return (
            <li
              key={feature.title}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              className={`home-protocol-feature-item ${isActive ? 'is-active' : ''}`}
              onMouseEnter={() => activateFeature(index)}
            >
              <button
                type="button"
                className="home-protocol-feature-trigger"
                aria-controls={descriptionId}
                aria-expanded={isActive}
                onClick={() => activateFeature(index)}
              >
                <span className="home-protocol-feature-title">{feature.title}</span>
              </button>

              {isActive ? <p id={descriptionId}>{feature.description}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
