import React from 'react';
import { Minus, Square, X } from './Icons';

export default function TitleBar() {
  const handleMinimize = () => window.api?.app.minimize();
  const handleMaximize = () => window.api?.app.maximize();
  const handleClose = () => window.api?.app.close();

  return (
    <div className="drag-region flex items-center justify-between h-9 bg-surface-100 border-b border-surface-200 dark:bg-surface-950 dark:border-surface-800 select-none">
      {/* App Title */}
      <div className="flex items-center px-4 gap-2">
        <img src="./logo.png" alt="Awesome Proxy" className="w-4 h-4 rounded object-cover" />
        <span className="text-xs text-surface-500 dark:text-surface-400 font-medium">Awesome Proxy</span>
      </div>

      {/* Window Controls */}
      <div className="flex h-full no-drag">
        <button
          onClick={handleMinimize}
          className="w-11 h-full flex items-center justify-center hover:bg-surface-200 dark:hover:bg-surface-800 transition-colors"
          title="Minimize"
        >
          <Minus size={14} className="text-surface-500 dark:text-surface-400" />
        </button>
        <button
          onClick={handleMaximize}
          className="w-11 h-full flex items-center justify-center hover:bg-surface-200 dark:hover:bg-surface-800 transition-colors"
          title="Maximize"
        >
          <Square size={12} className="text-surface-500 dark:text-surface-400" />
        </button>
        <button
          onClick={handleClose}
          className="w-11 h-full flex items-center justify-center hover:bg-red-600 transition-colors group"
          title="Close"
        >
          <X size={14} className="text-surface-500 dark:text-surface-400 group-hover:text-white" />
        </button>
      </div>
    </div>
  );
}