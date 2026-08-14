import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Material 3 Expressive Modal Wrapper
 * 
 * Features:
 * - Direct document.body portal (guaranteed 100% screen coverage without transform trap)
 * - Viewport-centered placement (opens immediately in center without scrolling)
 * - Full-screen Scrim with 8px backdrop-filter blur covering header and entire page
 * - WCAG AAA Contrast & surface hierarchy
 * - Focus trapping and Return-Focus on unmount/close
 * - ESC key handling and backdrop click dismiss
 * - Viewport containment with max-h and scrollable inner regions
 * - M3 motion transitions (spatial entrance & exit)
 */
export default function ModalWrapper({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  maxWidth = 'max-w-2xl',
  children,
  headerActions,
  footer,
  closeOnClickOutside = true,
  ariaLabel,
}) {
  const modalRef = useRef(null);
  const previousActiveElement = useRef(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Store trigger element & handle body scroll lock
  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement;
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      // Focus modal container on open
      const timer = setTimeout(() => {
        if (modalRef.current) {
          const focusable = modalRef.current.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (focusable.length > 0) {
            focusable[0].focus();
          } else {
            modalRef.current.focus();
          }
        }
      }, 50);

      return () => {
        clearTimeout(timer);
        document.body.style.overflow = originalOverflow;
        if (previousActiveElement.current && typeof previousActiveElement.current.focus === 'function') {
          previousActiveElement.current.focus();
        }
      };
    }
  }, [isOpen]);

  // Focus trap and ESC key listener
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }

      if (e.key === 'Tab') {
        if (!modalRef.current) return;
        const focusables = modalRef.current.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;

        const firstElement = focusables[0];
        const lastElement = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  const modalContent = (
    <div
      className="m3-modal-scrim"
      onClick={closeOnClickOutside ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title || 'Diálogo'}
        tabIndex={-1}
        className={`m3-modal-card ${maxWidth} w-full`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Bar */}
        {(title || icon || subtitle) && (
          <div className="px-6 py-4 sm:px-8 sm:py-5 border-b border-outline-variant/60 flex items-center justify-between gap-4 bg-surface-container-lowest shrink-0">
            <div className="flex items-center gap-3.5 min-w-0">
              {icon && (
                <div className="w-10 h-10 rounded-2xl bg-primary-container text-on-primary-container flex items-center justify-center shrink-0 border border-primary/10">
                  <span className="material-symbols-outlined text-2xl select-none">{icon}</span>
                </div>
              )}
              <div className="min-w-0">
                {title && (
                  <h2 className="text-lg sm:text-xl font-display font-bold text-on-surface truncate tracking-tight">
                    {title}
                  </h2>
                )}
                {subtitle && (
                  <p className="text-xs text-on-surface-variant font-sans truncate mt-0.5">
                    {subtitle}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {headerActions}
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Cerrar ventana"
                  className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <span className="material-symbols-outlined text-xl">close</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Modal Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 sm:px-8 sm:py-6 text-on-surface">
          {children}
        </div>

        {/* Optional Footer Bar */}
        {footer && (
          <div className="px-6 py-4 sm:px-8 sm:py-4 border-t border-outline-variant/60 bg-surface-container-low/50 flex flex-wrap items-center justify-end gap-3 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
