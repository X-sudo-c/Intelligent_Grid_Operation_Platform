import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Google Maps–style location puck with heading wedge and pulse ring.
class UserLocationMarker extends StatefulWidget {
  const UserLocationMarker({
    super.key,
    required this.heading,
    required this.headingConfidence,
    this.accuracyMeters,
    this.navigationMode = false,
  });

  /// Device heading in degrees clockwise from north (0–360).
  final double? heading;

  /// 0..1 confidence for heading quality.
  final double headingConfidence;
  final double? accuracyMeters;

  /// Uber-style: arrow fixed pointing up; map rotates underneath.
  final bool navigationMode;

  @override
  State<UserLocationMarker> createState() => _UserLocationMarkerState();
}

class _UserLocationMarkerState extends State<UserLocationMarker>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    )..repeat();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final heading = widget.heading;
    final showWedge = widget.navigationMode ||
        (heading != null && widget.headingConfidence >= 0.45);
    // Navigation mode: wedge stays screen-up; map bearing handles rotation.
    final wedgeRotation = widget.navigationMode
        ? 0.0
        : (heading != null ? heading * math.pi / 180 : 0.0);
    final wedgeOpacity = widget.navigationMode
        ? 1.0
        : widget.headingConfidence.clamp(0.35, 1.0);
    final accuracy = widget.accuracyMeters;
    final accuracyRadius = accuracy != null && accuracy.isFinite
        ? (12 + accuracy.clamp(3, 35) * 0.55)
        : 0.0;

    return SizedBox(
      width: 72,
      height: 72,
      child: Stack(
        alignment: Alignment.center,
        children: [
          if (accuracyRadius > 0)
            Container(
              width: accuracyRadius,
              height: accuracyRadius,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: const Color(0xFF1A73E8).withValues(alpha: 0.12),
                border: Border.all(
                  color: const Color(0xFF1A73E8).withValues(alpha: 0.28),
                  width: 1,
                ),
              ),
            ),
          AnimatedBuilder(
            animation: _pulse,
            builder: (context, child) {
              final t = _pulse.value;
              final scale = 1.0 + t * 0.55;
              final opacity = (1.0 - t) * 0.35;
              return Transform.scale(
                scale: scale,
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: Colors.blue.withValues(alpha: opacity),
                  ),
                ),
              );
            },
          ),
          if (showWedge)
            Opacity(
              opacity: wedgeOpacity,
              child: Transform.rotate(
                angle: wedgeRotation,
                child: CustomPaint(
                  size: const Size(56, 56),
                  painter: _HeadingWedgePainter(),
                ),
              ),
            ),
          Container(
            width: 18,
            height: 18,
            decoration: BoxDecoration(
              color: const Color(0xFF1A73E8),
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white, width: 3),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.25),
                  blurRadius: 6,
                  offset: const Offset(0, 2),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HeadingWedgePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    const radius = 28.0;
    const spread = 0.45;

    final path = Path()
      ..moveTo(center.dx, center.dy)
      ..arcTo(
        Rect.fromCircle(center: center, radius: radius),
        -math.pi / 2 - spread,
        spread * 2,
        false,
      )
      ..close();

    final fill = Paint()
      ..color = const Color(0xFF1A73E8).withValues(alpha: 0.38)
      ..style = PaintingStyle.fill;
    canvas.drawPath(path, fill);

    final edge = Paint()
      ..color = const Color(0xFF1A73E8).withValues(alpha: 0.65)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2;
    canvas.drawPath(path, edge);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

String headingToCardinal(double? heading) {
  if (heading == null) return '—';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  final idx = ((heading + 22.5) % 360 / 45).floor();
  return dirs[idx];
}
