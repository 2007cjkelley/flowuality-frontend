import { useEffect, useState } from 'react';

// Mobile layout breakpoint: phones in portrait (360-430px) are mobile; an
// iPad in portrait (768px) and anything wider keeps the desktop layout.
// Large phones in landscape (844-932px) deliberately stay desktop for now.
export const MOBILE_QUERY = '(max-width: 767px)';

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
