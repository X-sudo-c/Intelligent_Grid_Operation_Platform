import 'package:flutter_test/flutter_test.dart';
import 'package:vector_tile_renderer/vector_tile_renderer.dart';

import 'package:giop_field/map/giop_martin_theme.dart';

void main() {
  test('grid theme loads line layers with renderer-compatible filters', () {
    final theme = GiopMartinTheme.readGridTheme();
    final lineLayers =
        theme.layers.where((l) => l.type == ThemeLayerType.line).toList();
    expect(lineLayers.length, greaterThanOrEqualTo(6));
  });
}
