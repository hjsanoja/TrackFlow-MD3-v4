import ModalWrapper from './ModalWrapper';

export default function ConfirmModal({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirmar',
  cancelText = 'Cancelar',
  isDanger = false
}) {
  if (!isOpen) return null;

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      icon={isDanger ? 'warning' : 'help'}
      maxWidth="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="m3-btn-outline h-9 px-4 text-xs"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`h-9 px-5 rounded-full text-xs font-bold font-sans transition-all flex items-center justify-center shadow-elevation-1 active:scale-98 ${
              isDanger 
                ? 'bg-error text-on-error hover:bg-error/90' 
                : 'm3-btn-primary'
            }`}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <p className="text-sm text-on-surface-variant whitespace-pre-line leading-relaxed font-sans">
        {message}
      </p>
    </ModalWrapper>
  );
}
