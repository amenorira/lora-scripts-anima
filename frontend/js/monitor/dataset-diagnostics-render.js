/* 训练集诊断渲染聚合入口；由 monitor/render.js 装配。 */
(() => {
  window.datasetDiagnosticsRenderMixin = window.composeAppMixins(
    {},
    {
      datasetDiagnosticsFormatMixin: window.datasetDiagnosticsFormatMixin,
      datasetDiagnosticsScatterMixin: window.datasetDiagnosticsScatterMixin,
      datasetDiagnosticsTimestepMixin: window.datasetDiagnosticsTimestepMixin,
      datasetDiagnosticsModalMixin: window.datasetDiagnosticsModalMixin,
    },
  );
  window.monitorDatasetDiagRenderMixin = window.datasetDiagnosticsRenderMixin;
})();
