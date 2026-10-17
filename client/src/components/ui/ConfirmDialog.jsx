import React from 'react';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel, danger = false, isLoading = false }) {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={isLoading}>
            {isLoading ? t('common.working') : (confirmLabel || t('common.confirm'))}
          </Button>
        </>
      )}
    >
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>{message}</p>
    </Modal>
  );
}
