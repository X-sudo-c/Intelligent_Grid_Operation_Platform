import '../models/asset_kind.dart';

class CapturePrefill {
  const CapturePrefill({
    this.assetKind,
    this.substation,
    this.feederId,
    this.workOrderId,
    this.recaptureMrid,
    this.name,
    this.latitude,
    this.longitude,
  });

  final AssetKind? assetKind;
  final String? substation;
  final String? feederId;
  final String? workOrderId;
  final String? recaptureMrid;
  final String? name;
  final double? latitude;
  final double? longitude;
}
