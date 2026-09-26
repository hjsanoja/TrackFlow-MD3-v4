import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[400px] flex items-center justify-center p-6 m-4 rounded-3xl border border-outline-variant bg-surface-container-low">
          <div className="text-center max-w-md">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 bg-error-container text-on-error-container">
              <span className="material-symbols-outlined text-3xl" aria-hidden="true">error</span>
            </div>
            <h3 className="m3-title-large text-on-surface mb-2">Ocurrió un error inesperado</h3>
            <p className="m3-body-medium text-on-surface-variant mb-6">
              Algo falló al mostrar esta pantalla. Recarga para intentarlo de nuevo.
            </p>
            <button type="button" onClick={this.handleReset} className="m3-btn-primary mx-auto">
              <span className="material-symbols-outlined text-base" aria-hidden="true">refresh</span>
              <span>Recargar</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
