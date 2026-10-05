import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { BrandMark } from '../StatusBar/StatusBar.tsx';
import './OnboardingFrame.css';

export interface OnboardingFrameProps {
  title: string;
  stepLabel: string;
  children: ReactNode;
  footer: ReactNode;
}

/**
 * The onboarding step frame: a top bar with the brand, then a main column with
 * the heading, the step line, the step's content and its buttons. The heading
 * takes focus on mount and whenever the title changes, and at no other time.
 */
export function OnboardingFrame({ title, stepLabel, children, footer }: OnboardingFrameProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, [title]);
  return (
    <div className="d-onboarding-frame">
      <header className="d-onboarding-frame__bar"><BrandMark /></header>
      <main className="d-onboarding-frame__card">
        <h1 ref={titleRef} tabIndex={-1} className="d-onboarding-frame__title">{title}</h1>
        {stepLabel ? <p className="d-onboarding-frame__step d-label">{stepLabel}</p> : null}
        <div className="d-onboarding-frame__body">{children}</div>
        {footer === null || footer === undefined || footer === false ? null : <div className="d-onboarding-frame__footer">{footer}</div>}
      </main>
    </div>
  );
}
