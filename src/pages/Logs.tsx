import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Search, Download, Filter } from '../components/Icons';

export default function Logs() {
  const [logs, setLogs] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load existing logs
    const loadLogs = async () => {
      try {
        if (window.api) {
          const existingLogs = await window.api.singbox.getLogs();
          setLogs(existingLogs);
        }
      } catch {
        // Dev mode
      }
    };
    loadLogs();

    // Listen for new logs
    if (window.api) {
      window.api.singbox.onLog((log: string) => {
        setLogs((prev) => [...prev, log]);
      });
    }
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleClear = async () => {
    setLogs([]);
    if (window.api) {
      await window.api.singbox.clearLogs();
    }
  };

  const handleExport = () => {
    const text = logs.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `singbox-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLogs = filter
    ? logs.filter((log) => log.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  const getLogLevelColor = (log: string): string => {
    if (log.includes('ERROR') || log.includes('error') || log.includes('FATAL')) return 'text-red-400';
    if (log.includes('WARN') || log.includes('warn')) return 'text-yellow-400';
    if (log.includes('DEBUG') || log.includes('debug') || log.includes('TRACE')) return 'text-surface-500';
    if (log.includes('INFO') || log.includes('info') || log.includes('started')) return 'text-green-400';
    return 'text-surface-300';
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface-100">Logs</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-surface-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3.5 h-3.5 rounded"
            />
            Auto-scroll
          </label>
          <button onClick={handleExport} className="btn-secondary flex items-center gap-1.5" disabled={logs.length === 0}>
            <Download size={14} />
            Export
          </button>
          <button onClick={handleClear} className="btn-secondary flex items-center gap-1.5" disabled={logs.length === 0}>
            <Trash2 size={14} />
            Clear
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
        <input
          type="text"
          placeholder="Filter logs..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input-field pl-9"
        />
      </div>

      {/* Log Stats */}
      <div className="text-xs text-surface-500">
        {filteredLogs.length} of {logs.length} entries
        {filter && ` (filtered by "${filter}")`}
      </div>

      {/* Log Container */}
      <div
        ref={logContainerRef}
        className="flex-1 overflow-y-auto bg-surface-950 border border-surface-800 rounded-lg p-3 font-mono text-xs leading-relaxed"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-center py-16">
            <Filter size={48} className="mx-auto text-surface-700 mb-3" />
            <p className="text-surface-500">No log entries</p>
            <p className="text-xs text-surface-600 mt-1">
              {logs.length === 0 ? 'Start sing-box to see logs' : 'No logs match the current filter'}
            </p>
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div
              key={index}
              className={`py-0.5 ${getLogLevelColor(log)} hover:bg-surface-800/30 px-1 -mx-1 rounded`}
            >
              {log}
            </div>
          ))
        )}
      </div>
    </div>
  );
}