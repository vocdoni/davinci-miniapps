import { useEffect, useRef, useState } from 'react';

interface DemoVideoItem {
  title: string;
  videoUrl: string;
}

interface DemoVideoSectionProps {
  ariaLabel: string;
  title: string;
  items: readonly DemoVideoItem[];
}

export default function DemoVideoSection({ ariaLabel, title, items }: DemoVideoSectionProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  if (!items.length) return null;

  const safeIndex = Math.min(activeIndex, items.length - 1);
  const activeItem = items[safeIndex];

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    if (!('IntersectionObserver' in window)) {
      setIsVisible(true);
      return undefined;
    }

    const node = sectionRef.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsVisible(Boolean(entry?.isIntersecting));
      },
      { threshold: 0.45 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const videoNode = videoRef.current;
    if (!videoNode) return;

    if (!isVisible) {
      videoNode.pause();
      return;
    }

    try {
      videoNode.currentTime = 0;
      const playPromise = videoNode.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } catch {
    }
  }, [activeItem.videoUrl, isVisible, safeIndex]);

  return (
    <section ref={sectionRef} className="home-demo-slideshow" aria-label={ariaLabel}>
      <div className="home-demo-header">
        <h2 className="home-demo-title">{title}</h2>
      </div>

      <div className="home-demo-layout">
        <div className="home-demo-steps" role="tablist" aria-label={`${ariaLabel} steps`}>
          {items.map((item, index) => {
            const isActive = index === safeIndex;

            return (
              <button
                key={item.title}
                type="button"
                className={`home-demo-step ${isActive ? 'is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => setActiveIndex(index)}
              >
                <span className="home-demo-step-index" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="home-demo-step-title">{item.title}</span>
              </button>
            );
          })}
        </div>

        <div className="home-demo-video-shell">
          <video
            ref={videoRef}
            key={`${activeItem.title}-${activeItem.videoUrl}`}
            className="home-demo-video"
            src={activeItem.videoUrl}
            preload="metadata"
            muted
            loop
            playsInline
            controls={false}
            aria-label={`${activeItem.title} demo video`}
          />
        </div>
      </div>
    </section>
  );
}
