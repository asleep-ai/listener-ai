// Notification helpers extracted from legacy.ts.
// - showNotification: top-right slide-in banner used for transient errors/info.
// - showToast: bottom toast used after copy / mic-switch actions.
// setupNotifications is exported for symmetry with the other ui/* modules
// even though there is no DOM wiring at module init time -- the banners and
// toasts are created on demand.

export type NotificationType = 'info' | 'error';
export type ToastType = 'success' | 'error';

export function setupNotifications(): void {
  // No DOM wiring required; both helpers create their own elements on demand.
}

export function showNotification(message: string, type: NotificationType = 'info'): void {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'error' ? '#ef4444' : '#3b82f6'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

// Show toast notification
export function showToast(message: string, type: ToastType = 'success'): void {
  // Remove any existing toast
  const existingToast = document.querySelector('.toast');
  if (existingToast) {
    existingToast.remove();
  }

  // Create new toast
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;

  if (type === 'error') {
    toast.style.background = '#e74c3c';
  }

  document.body.appendChild(toast);

  // Remove toast after 3 seconds
  setTimeout(() => {
    toast.remove();
  }, 3000);
}
