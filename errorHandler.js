// Error handler module for Listener.AI
// Handles application errors with user-friendly messages

class ErrorHandler {
  constructor() {
    this.errorMappings = {
      'process is not defined': {
        title: 'Application initialization error',
        message: 'The application encountered an issue accessing system information.',
        action: 'This is likely due to outdated application files. Please restart Listener.AI to apply the latest updates.'
      },
      'electronAPI': {
        title: 'Application interface error',
        message: 'The application failed to establish communication with system services.',
        action: 'Please close and restart Listener.AI. If the problem persists, try reinstalling the application.'
      },
      'Cannot read properties of null': {
        title: 'User interface error',
        message: 'A UI component failed to load properly.',
        action: 'Please refresh the application window or restart Listener.AI.'
      },
      'Failed to fetch': {
        title: 'Network connection error',
        message: 'Unable to connect to required services.',
        action: 'Please check your internet connection and try again.'
      },
      'API key': {
        title: 'Configuration error',
        message: 'API credentials are missing or invalid.',
        action: 'Please check your API key configuration in Settings.'
      },
      'quota': {
        title: 'API quota exceeded',
        message: 'You have exceeded your API usage limits.',
        action: 'Please try again later or upgrade your API plan.'
      },
      'FFmpeg not found': {
        title: 'Missing dependency',
        message: 'FFmpeg is required for audio processing but was not found.',
        action: 'Please install FFmpeg or let the application download it automatically.'
      },
      'Microphone permission': {
        title: 'Permission denied',
        message: 'Microphone access is required to record audio.',
        action: 'Please grant microphone permission in System Settings and restart the application.'
      },
      'No audio devices': {
        title: 'No microphone detected',
        message: 'No audio input device was found.',
        action: 'Please connect a microphone or check your audio settings.'
      }
    };
  }

  /**
   * Get error details based on the error message
   * @param {Error} error - The error object
   * @returns {Object} Error details with title, message, and action
   */
  getErrorDetails(error) {
    if (!error || !error.message) {
      return {
        title: 'Unknown error',
        message: 'An unexpected error occurred.',
        action: 'Please restart the application.'
      };
    }

    // Check each error mapping
    for (const [key, details] of Object.entries(this.errorMappings)) {
      if (error.message.toLowerCase().includes(key.toLowerCase())) {
        return details;
      }
    }

    // Default error details
    return {
      title: 'Application error',
      message: error.message || 'Unknown error',
      action: 'Please try again or restart the application.'
    };
  }

  /**
   * Format error for display
   * @param {Error} error - The error object
   * @returns {Object} Formatted error details
   */
  formatError(error) {
    const details = this.getErrorDetails(error);
    
    // Add technical details if available
    if (error && error.stack && process.env.NODE_ENV === 'development') {
      details.technicalInfo = error.stack;
    } else if (error && error.filename && error.lineno) {
      details.technicalInfo = `${error.filename}:${error.lineno}`;
    }

    return details;
  }

  /**
   * Show error to user
   * @param {Error} error - The error object
   * @param {boolean} isProduction - Whether running in production
   */
  async showError(error, isProduction = true) {
    const errorInfo = this.formatError(error);
    
    // Log to console always
    console.error('Application error:', error);
    
    // Only show UI in production
    if (isProduction) {
      if (window.electronAPI && window.electronAPI.showErrorDialog) {
        // Use Electron's native error dialog
        await window.electronAPI.showErrorDialog(
          errorInfo.title,
          errorInfo.message,
          errorInfo.action + (errorInfo.technicalInfo ? `\n\nTechnical details: ${errorInfo.technicalInfo}` : '')
        );
      } else {
        // Fallback to browser alert
        const fullMessage = `${errorInfo.title}\n\n${errorInfo.message}\n\n${errorInfo.action}`;
        alert(fullMessage);
      }
    }
  }

  /**
   * Install global error handler
   */
  install() {
    window.addEventListener('error', (event) => {
      const isProduction = !window.location.href.includes('localhost');
      this.showError(event.error, isProduction);
    });

    // Also catch unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const isProduction = !window.location.href.includes('localhost');
      const error = new Error(event.reason?.message || event.reason || 'Unhandled promise rejection');
      this.showError(error, isProduction);
    });
  }
}

// Export singleton instance
const errorHandler = new ErrorHandler();

// For CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = errorHandler;
}