"""IEC 61968 / 61970 CIM RDF/XML serializer (CIM100 profile).

Produces CGMES-style RDF/XML with:
  * rdf:RDF root and cim: class elements
  * IdentifiedObject.mRID / name / lifecycleState
  * Terminal stubs for ACLineSegment ↔ ConnectivityNode associations
  * Location + PositionPoint for geospatial objects
  * gio: namespace for documented GIOP local extensions
"""

from __future__ import annotations

import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any

from cim_export import CIM_PROFILE

NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
NS_CIM = "http://iec.ch/TC57/CIM100#"
NS_MD = "http://iec.ch/TC57/61970-552#"
NS_GIO = "http://giop.ecg.gh/extensions#"

APPROVED_PROFILES = (
    "IEC61970-452",
    "IEC61968",
    "IEC61968-9",
    CIM_PROFILE,
)

LIFECYCLE_MAP = {
    "PLANNING": "Planned",
    "IN_CONSTRUCTION": "UnderConstruction",
    "IN_SERVICE": "InService",
    "OUT_OF_SERVICE": "OutOfService",
    "ABANDONED": "Retired",
}

VOLTAGE_VOLTS = {
    "LV_230V": 230,
    "LV_400V": 400,
    "MV_11KV": 11000,
    "MV_33KV": 33000,
    "HV_161KV": 161000,
    "HV_330KV": 330000,
}

ET.register_namespace("rdf", NS_RDF)
ET.register_namespace("cim", NS_CIM)
ET.register_namespace("md", NS_MD)
ET.register_namespace("gio", NS_GIO)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rdf_id(mrid: str) -> str:
    return f"_{mrid}"


def _cim(parent: ET.Element, tag: str) -> ET.Element:
    return ET.SubElement(parent, f"{{{NS_CIM}}}{tag}")


def _md(parent: ET.Element, tag: str) -> ET.Element:
    return ET.SubElement(parent, f"{{{NS_MD}}}{tag}")


def _gio(parent: ET.Element, tag: str) -> ET.Element:
    return ET.SubElement(parent, f"{{{NS_GIO}}}{tag}")


def _lit(parent: ET.Element, cim_tag: str, value: Any, *, dtype: str | None = None) -> None:
    if value is None:
        return
    el = _cim(parent, cim_tag)
    el.text = str(value)
    if dtype:
        el.set(f"{{{NS_RDF}}}datatype", dtype)


def _ref(parent: ET.Element, cim_tag: str, resource: str) -> None:
    el = _cim(parent, cim_tag)
    el.set(f"{{{NS_RDF}}}resource", resource)


def _identified_object(el: ET.Element, *, mrid: str, name: str | None, lifecycle: str | None) -> None:
    _lit(el, "IdentifiedObject.mRID", mrid)
    if name:
        _lit(el, "IdentifiedObject.name", name)
    if lifecycle:
        mapped = LIFECYCLE_MAP.get(lifecycle, lifecycle)
        _lit(el, "IdentifiedObject.lifecycleState", mapped)


def _ensure_base_voltage(root: ET.Element, seen: set[str], voltage_code: str | None) -> str | None:
    if not voltage_code:
        return None
    vid = f"#_bv-{voltage_code}"
    if voltage_code in seen:
        return vid
    seen.add(voltage_code)
    bv = _cim(root, "BaseVoltage")
    bv.set(f"{{{NS_RDF}}}ID", f"_bv-{voltage_code}")
    _lit(bv, "IdentifiedObject.mRID", f"bv-{voltage_code}")
    volts = VOLTAGE_VOLTS.get(voltage_code)
    if volts is not None:
        _lit(bv, "BaseVoltage.nominalVoltage", volts, dtype="http://www.w3.org/2001/XMLSchema#float")
    _lit(bv, "IdentifiedObject.name", voltage_code)
    return vid


def _add_position(root: ET.Element, mrid: str, geom: dict[str, Any] | None) -> None:
    if not geom or geom.get("type") != "Point":
        return
    coords = geom.get("coordinates") or []
    if len(coords) < 2:
        return
    lon, lat = float(coords[0]), float(coords[1])
    loc_id = f"_loc-{_rdf_id(mrid).lstrip('_')}"
    pp_id = f"_pp-{_rdf_id(mrid).lstrip('_')}"

    loc = _cim(root, "Location")
    loc.set(f"{{{NS_RDF}}}ID", loc_id)
    _lit(loc, "IdentifiedObject.mRID", f"loc-{mrid}")
    _ref(loc, "Location.PositionPoints", f"#{pp_id}")

    pp = _cim(root, "PositionPoint")
    pp.set(f"{{{NS_RDF}}}ID", pp_id)
    _lit(pp, "IdentifiedObject.mRID", f"pp-{mrid}")
    _lit(pp, "PositionPoint.xPosition", lon, dtype="http://www.w3.org/2001/XMLSchema#float")
    _lit(pp, "PositionPoint.yPosition", lat, dtype="http://www.w3.org/2001/XMLSchema#float")
    _lit(pp, "PositionPoint.zPosition", 0.0, dtype="http://www.w3.org/2001/XMLSchema#float")


def _add_connectivity_node(root: ET.Element, node: dict[str, Any], bv_seen: set[str]) -> None:
    mrid = node["mrid"]
    el = _cim(root, "ConnectivityNode")
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=node.get("name"), lifecycle=node.get("lifecycle_state"))
    feeder = node.get("boundary_feeder_id")
    if feeder:
        _lit(el, "IdentifiedObject.description", f"feeder={feeder}")
        gio_el = _gio(el, "ConnectivityNode.boundaryFeederId")
        gio_el.text = str(feeder)
    voltage = node.get("nominal_voltage")
    bv_ref = _ensure_base_voltage(root, bv_seen, voltage)
    if bv_ref:
        _ref(el, "ConnectivityNode.BaseVoltage", bv_ref)
    _add_position(root, mrid, node.get("location"))


def _terminal_mrid(line_mrid: str, seq: int) -> str:
    return f"{line_mrid}-T{seq}"


def _term_rdf_id(line_mrid: str, seq: int) -> str:
    safe = line_mrid.replace("-", "")
    return f"term_{safe}_T{seq}"


def _add_ac_line_segment(root: ET.Element, line: dict[str, Any], bv_seen: set[str]) -> None:
    mrid = line["mrid"]
    src = line.get("source_node_mrid")
    tgt = line.get("target_node_mrid")

    for seq, node_mrid in ((1, src), (2, tgt)):
        if not node_mrid:
            continue
        tid = _term_rdf_id(mrid, seq)
        term = _cim(root, "Terminal")
        term.set(f"{{{NS_RDF}}}ID", tid)
        _lit(term, "IdentifiedObject.mRID", _terminal_mrid(mrid, seq))
        _ref(term, "Terminal.ConnectivityNode", f"#{_rdf_id(node_mrid)}")
        _ref(term, "Terminal.ConductingEquipment", f"#{_rdf_id(mrid)}")
        _lit(term, "ACDCTerminal.sequenceNumber", seq, dtype="http://www.w3.org/2001/XMLSchema#integer")

    seg = _cim(root, "ACLineSegment")
    seg.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(seg, mrid=mrid, name=line.get("name"), lifecycle=None)
    phases = line.get("phases")
    if phases:
        _lit(seg, "ConductingEquipment.phases", phases)
    voltage = line.get("nominal_voltage")
    bv_ref = _ensure_base_voltage(root, bv_seen, voltage)
    if bv_ref:
        _ref(seg, "ConductingEquipment.BaseVoltage", bv_ref)
    if src:
        _ref(seg, "Equipment.Terminals", f"#{_term_rdf_id(mrid, 1)}")
    if tgt:
        _ref(seg, "Equipment.Terminals", f"#{_term_rdf_id(mrid, 2)}")
    if line.get("direction_downstream") is not None:
        gio_el = _gio(seg, "ACLineSegment.directionDownstream")
        gio_el.text = str(line["direction_downstream"]).lower()


def _add_usage_point(root: ET.Element, up: dict[str, Any]) -> None:
    mrid = up["mrid"]
    el = _cim(root, "UsagePoint")
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=up.get("name"), lifecycle=None)
    account = up.get("account_mrid")
    if account:
        _lit(el, "IdentifiedObject.description", f"account_mrid={account}")
        gio_el = _gio(el, "UsagePoint.accountMrid")
        gio_el.text = str(account)
    _add_position(root, mrid, up.get("location"))


def _add_meter(root: ET.Element, meter: dict[str, Any]) -> None:
    mrid = meter["mrid"]
    el = _cim(root, "Meter")
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=meter.get("name"), lifecycle=None)
    serial = meter.get("serial_number")
    if serial:
        _lit(el, "EndDevice.serialNumber", serial)
    mfr = meter.get("manufacturer")
    if mfr:
        _lit(el, "EndDevice.manufacturer", mfr)
    installed = meter.get("installed_at")
    if installed:
        gio_el = _gio(el, "Meter.installedAt")
        gio_el.text = str(installed)


def _pt_term_rdf_id(equipment_mrid: str) -> str:
    safe = equipment_mrid.replace("-", "")
    return f"pt_term_{safe}"


def _add_power_transformer(root: ET.Element, pt: dict[str, Any], bv_seen: set[str]) -> None:
    mrid = pt["mrid"]
    cn_mrid = pt.get("connectivity_node_mrid")
    if cn_mrid:
        tid = _pt_term_rdf_id(mrid)
        term = _cim(root, "Terminal")
        term.set(f"{{{NS_RDF}}}ID", tid)
        _lit(term, "IdentifiedObject.mRID", f"{mrid}-T1")
        _ref(term, "Terminal.ConnectivityNode", f"#{_rdf_id(cn_mrid)}")
        _ref(term, "Terminal.ConductingEquipment", f"#{_rdf_id(mrid)}")
        _lit(term, "ACDCTerminal.sequenceNumber", 1, dtype="http://www.w3.org/2001/XMLSchema#integer")

    el = _cim(root, "PowerTransformer")
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=pt.get("name"), lifecycle=None)
    phases = pt.get("phases")
    if phases:
        _lit(el, "ConductingEquipment.phases", phases)
    voltage = pt.get("nominal_voltage")
    bv_ref = _ensure_base_voltage(root, bv_seen, voltage)
    if bv_ref:
        _ref(el, "ConductingEquipment.BaseVoltage", bv_ref)
    if cn_mrid:
        _ref(el, "Equipment.Terminals", f"#{_pt_term_rdf_id(mrid)}")
    rated = pt.get("rated_power_kva")
    if rated is not None:
        gio_el = _gio(el, "PowerTransformer.ratedPowerKva")
        gio_el.text = str(rated)
    vector_group = pt.get("vector_group")
    if vector_group:
        gio_el = _gio(el, "PowerTransformer.vectorGroup")
        gio_el.text = str(vector_group)
    kind = pt.get("transformer_kind")
    if kind:
        gio_el = _gio(el, "PowerTransformer.transformerKind")
        gio_el.text = str(kind)
    if cn_mrid:
        _add_position(root, cn_mrid, pt.get("location"))


def _add_cim_asset(root: ET.Element, asset: dict[str, Any]) -> None:
    mrid = asset["mrid"]
    equipment_mrid = asset.get("equipment_mrid")
    el = _cim(root, "Asset")
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=asset.get("name"), lifecycle=None)
    if equipment_mrid:
        _ref(el, "Asset.PowerSystemResources", f"#{_rdf_id(equipment_mrid)}")
    kind = asset.get("asset_kind")
    if kind:
        gio_el = _gio(el, "Asset.assetKind")
        gio_el.text = str(kind)


def _add_asset_info(root: ET.Element, info: dict[str, Any]) -> None:
    mrid = info["mrid"]
    info_type = info.get("@type") or "PowerTransformerInfo"
    tag = "PowerTransformerInfo" if info_type == "PowerTransformerInfo" else "AssetInfo"
    el = _cim(root, tag)
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=info.get("name"), lifecycle=None)
    asset_mrid = info.get("asset_mrid")
    if asset_mrid:
        _ref(el, "AssetInfo.Asset", f"#{_rdf_id(asset_mrid)}")
    manufacturer = info.get("manufacturer")
    if manufacturer:
        _lit(el, "AssetInfo.manufacturer", manufacturer)
    model = info.get("model_number")
    if model:
        _lit(el, "AssetInfo.modelNumber", model)
    serial = info.get("serial_number")
    if serial:
        _lit(el, "AssetInfo.serialNumber", serial)
    rated = info.get("rated_power_kva")
    if rated is not None and tag == "PowerTransformerInfo":
        _lit(el, "PowerTransformerInfo.ratedPower", rated, dtype="http://www.w3.org/2001/XMLSchema#float")
    year = info.get("year_of_manufacture")
    if year is not None:
        _lit(el, "AssetInfo.manufacturedYear", year, dtype="http://www.w3.org/2001/XMLSchema#integer")


def _add_ghana_grid_asset(root: ET.Element, asset: dict[str, Any]) -> None:
    mrid = asset["mrid"]
    el = _cim(root, "PowerSystemResource")
    el.set(f"{{{NS_RDF}}}ID", _rdf_id(mrid))
    _identified_object(el, mrid=mrid, name=asset.get("substation_name"), lifecycle=None)
    utility = asset.get("operating_utility")
    if utility:
        gio_el = _gio(el, "GhanaGridAsset.operatingUtility")
        gio_el.text = str(utility)
    substation = asset.get("substation_name")
    if substation:
        gio_el = _gio(el, "GhanaGridAsset.substationName")
        gio_el.text = str(substation)


def _md_lit(parent: ET.Element, md_tag: str, value: Any, *, dtype: str | None = None) -> None:
    if value is None:
        return
    el = _md(parent, md_tag)
    el.text = str(value)
    if dtype:
        el.set(f"{{{NS_RDF}}}datatype", dtype)


def _full_model_header(root: ET.Element, *, exported_at: str, profiles: tuple[str, ...]) -> None:
    model_id = f"_model-{uuid.uuid4()}"
    fm = _md(root, "FullModel")
    fm.set(f"{{{NS_RDF}}}about", f"#{model_id}")
    _md_lit(fm, "Model.created", exported_at)
    _md_lit(fm, "Model.version", "1")
    _md_lit(fm, "Model.scenarioTime", exported_at)
    desc = f"GIOP master export; profiles={','.join(profiles)}"
    _md(fm, "FullModel.modelDescription").text = desc


def build_cim_rdf_xml(payload: dict[str, Any]) -> str:
    """Convert a CIM JSON profile payload to IEC CIM100 RDF/XML."""
    exported_at = payload.get("exported_at") or _utc_now()
    if exported_at.endswith("+00:00"):
        exported_at = exported_at.replace("+00:00", "Z")
    profiles = tuple(dict.fromkeys([*APPROVED_PROFILES, payload.get("@profile", CIM_PROFILE)]))

    root = ET.Element(f"{{{NS_RDF}}}RDF")
    _full_model_header(root, exported_at=exported_at, profiles=profiles)

    bv_seen: set[str] = set()

    for node in payload.get("ConnectivityNode") or []:
        _add_connectivity_node(root, node, bv_seen)

    for line in payload.get("ACLineSegment") or []:
        _add_ac_line_segment(root, line, bv_seen)

    for pt in payload.get("PowerTransformer") or []:
        _add_power_transformer(root, pt, bv_seen)

    for asset in payload.get("Asset") or []:
        _add_cim_asset(root, asset)

    for info in payload.get("AssetInfo") or []:
        _add_asset_info(root, info)

    for up in payload.get("UsagePoint") or []:
        _add_usage_point(root, up)

    for meter in payload.get("Meter") or []:
        _add_meter(root, meter)

    extensions = payload.get("extensions") or {}
    for asset in extensions.get("GhanaGridAsset") or []:
        _add_ghana_grid_asset(root, asset)

    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return xml_bytes.decode("utf-8")


def build_cim_rdf_meta(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "@format": "cim-rdf",
        "@profile": payload.get("@profile", CIM_PROFILE),
        "@cim_namespace": NS_CIM,
        "@profiles": list(APPROVED_PROFILES),
        "exported_at": payload.get("exported_at") or _utc_now(),
        "filters": payload.get("filters"),
        "counts": payload.get("counts"),
        "mapping_register_entries": len(payload.get("cim_mapping_register") or []),
    }


def validate_rdf_fragment(text: str) -> None:
    """Basic structural checks before marking export complete."""
    if NS_RDF not in text or NS_CIM not in text:
        raise ValueError("RDF/XML missing required CIM namespaces")
    if "IdentifiedObject.mRID" not in text:
        raise ValueError("RDF/XML contains no CIM IdentifiedObject.mRID elements")
    ET.fromstring(text.encode("utf-8"))
