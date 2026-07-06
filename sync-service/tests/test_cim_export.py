"""Unit tests for CIM JSON export payload assembly."""

from cim_export import CIM_PROFILE, DEFAULT_LAYERS


def test_cim_profile_includes_equipment_layers():
    assert CIM_PROFILE == "GIOP-Distribution-MVP-1.1"
    assert "power_transformers" in DEFAULT_LAYERS
    assert "cim_assets" in DEFAULT_LAYERS
    assert "cim_asset_info" in DEFAULT_LAYERS
