import streamlit as st
import trimesh
import numpy as np
import tempfile
from shapely.geometry import Polygon

def process_vector_to_mesh(file_obj, file_type, thickness):
    """
    ベクターファイルを読み込み、閉じた形状（Polygon）を探して押し出す関数
    バラバラの線分から閉じた領域を検出するロジックを強化しています。
    """
    try:
        # ファイルをロード
        scene = trimesh.load(file_obj, file_type=file_type)
        
        meshes = []
        
        # Sceneならジオメトリ辞書の値を取得、Path2Dならリスト化
        if isinstance(scene, trimesh.Scene):
            geometries = list(scene.geometry.values())
        else:
            geometries = [scene]

        found_closed_shape = False

        for geom in geometries:
            if isinstance(geom, trimesh.path.Path2D):
                # ---------------------------------------------------------
                # 修正ポイント: Path2D.extrude() を直接使わず、
                # Shapelyのポリゴン抽出機能を使って閉じた領域だけを取り出す
                # ---------------------------------------------------------
                
                # polygons_full は、パス内の「閉じた領域」をShapelyのPolygonとして返します
                # これにより、バラバラの線でも閉じていれば検出されます
                polygons = geom.polygons_full
                
                if not polygons:
                    # 閉じた領域が見つからない場合
                    continue
                
                found_closed_shape = True
                
                for poly in polygons:
                    # ShapelyのPolygonをTrimeshの押し出し機能で立体化
                    try:
                        # 押し出し処理
                        mesh = trimesh.creation.extrude_polygon(poly, height=thickness)
                        meshes.append(mesh)
                    except Exception as e:
                        print(f"ポリゴンの押し出しに失敗: {e}")
                        continue

        if not meshes:
            return None, found_closed_shape

        # 全てのメッシュを結合
        if len(meshes) > 1:
            final_mesh = trimesh.util.concatenate(meshes)
        else:
            final_mesh = meshes[0]
        
        final_mesh.fix_normals()
        return final_mesh, found_closed_shape

    except Exception as e:
        st.error(f"処理エラー: {e}")
        return None, False

# --- Streamlit UI ---

st.set_page_config(page_title="Vector to STL Converter", layout="centered")
st.title("Vector to STL Converter")
st.markdown("""
DXF/SVGをアップロードしてSTLに変換します。
**閉じた曲線のみを押し出します。**
""")

st.sidebar.header("設定")
thickness = st.sidebar.number_input("押し出し厚み (mm)", min_value=0.1, value=5.0, step=0.1, format="%.1f")

uploaded_file = st.file_uploader("ベクターファイル (DXF / SVG)", type=["dxf", "svg"])

if uploaded_file:
    file_ext = uploaded_file.name.split('.')[-1].lower()
    uploaded_file.seek(0)
    
    # 処理実行
    mesh, found_shape = process_vector_to_mesh(uploaded_file, file_ext, thickness)

    if mesh and not mesh.is_empty:
        st.success("変換成功！")
        
        col1, col2 = st.columns(2)
        col1.metric("頂点数", len(mesh.vertices))
        col2.metric("面数", len(mesh.faces))

        # プレビュー
        with st.expander("3Dプレビュー"):
            with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as tmp:
                mesh.export(tmp.name)
                st.write("※簡易ビューア")

        # ダウンロードボタン
        stl_data = trimesh.exchange.stl.export_stl(mesh)
        st.download_button(
            label="STLをダウンロード",
            data=stl_data,
            file_name=f"{uploaded_file.name.split('.')[0]}_extruded.stl",
            mime="model/stl"
        )
    elif not found_shape:
        st.warning("⚠️ 閉じた領域が見つかりませんでした。")
        st.info("""
        **考えられる原因と対策:**
        1. **線が繋がっていない:** CADで拡大して、角が離れていないか確認してください。
        2. **ポリライン化:** CADソフトで `JOIN` (結合) コマンドや `PEDIT` を使い、線を1つの連続したポリラインに変換してください。
        3. **自己交差:** 線が8の字に交差しているとエラーになる場合があります。
        """)
    else:
        st.error("形状の検出はできましたが、メッシュ生成に失敗しました。")

st.caption("Powered by Python, Streamlit, Trimesh & Shapely")

