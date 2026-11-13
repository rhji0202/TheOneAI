import { createContext } from 'react';

/** Radix 팝업을 Shadow DOM 안에 그리기 위한 컨테이너 (없으면 document.body 로 나가 스타일이 빠진다) */
export const PortalContainerContext = createContext<HTMLElement | null>(null);
