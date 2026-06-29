import 'package:flutter/material.dart';
import 'package:vector_map_tiles/vector_map_tiles.dart';

import '../map/giop_martin_theme.dart';
import '../map/giop_sld_colors.dart';

/// Compact SLD legend matching the portal Network Map.
class GiopMapLegendChip extends StatelessWidget {
  const GiopMapLegendChip({super.key});

  @override
  Widget build(BuildContext context) {
    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(10),
      color: Colors.white.withValues(alpha: 0.94),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Grid layers',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
            ),
            const SizedBox(height: 6),
            const _LegendRow(color: GiopSldColors.mv33kv, label: '33 kV — overhead'),
            const _LegendRow(color: GiopSldColors.mv11kv, label: '11 kV — overhead'),
            const _LegendRow(color: GiopSldColors.lv, label: 'LV — overhead'),
            const _LegendRow(
              color: GiopSldColors.mv33kv,
              label: 'Underground cable',
              dashed: true,
            ),
            const _LegendRow(
              color: GiopSldColors.distributionTransformer,
              label: 'DT',
              shape: BoxShape.circle,
            ),
            const _LegendRow(
              color: GiopSldColors.nodeFill,
              label: 'Pole / node',
              shape: BoxShape.circle,
              small: true,
            ),
          ],
        ),
      ),
    );
  }
}

class _LegendRow extends StatelessWidget {
  const _LegendRow({
    required this.color,
    required this.label,
    this.dashed = false,
    this.shape = BoxShape.rectangle,
    this.small = false,
  });

  final Color color;
  final String label;
  final bool dashed;
  final BoxShape shape;
  final bool small;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dashed)
            SizedBox(
              width: 22,
              height: 3,
              child: CustomPaint(painter: _DashPainter(color)),
            )
          else
            Container(
              width: small ? 8 : 14,
              height: small ? 8 : (shape == BoxShape.circle ? 14 : 3),
              decoration: BoxDecoration(
                color: color,
                shape: shape,
                border: shape == BoxShape.circle
                    ? Border.all(color: Colors.white, width: 1)
                    : null,
              ),
            ),
          const SizedBox(width: 8),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _DashPainter extends CustomPainter {
  _DashPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke;
    canvas.drawLine(Offset.zero, Offset(size.width, 0), paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Martin vector grid overlay (portal-style conductors + nodes).
class GiopGridVectorLayer extends StatelessWidget {
  const GiopGridVectorLayer({super.key, required this.martinBaseUrl});

  final String martinBaseUrl;

  @override
  Widget build(BuildContext context) {
    return VectorTileLayer(
      theme: GiopMartinTheme.readGridTheme(),
      tileProviders: GiopMartinTheme.tileProviders(martinBaseUrl),
      layerMode: VectorTileLayerMode.raster,
      concurrency: 4,
      memoryTileCacheMaxSize: 12 * 1024 * 1024,
    );
  }
}
