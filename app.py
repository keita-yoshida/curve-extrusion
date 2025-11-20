import streamlit as st
import trimesh
import numpy as np
import plotly.graph_objects as go
from shapely.geometry import Polygon

def process_vector_to_mesh(file_obj, file_type, thickness):
    """
    ベクターファイルを読み込み、閉じた形状（Polygon）を探して押し出す関数
    """
    try:
        scene = trimesh.load(file_obj, file_type=file_type)
        meshes = []
        
        if isinstance(scene, trimesh.Scene):
            geometries = list(scene.geometry.values())
        else:
            geometries = [scene]

        found_closed_shape = False

        for geom in geometries:
            if isinstance(geom, trimesh.path.Path2D):
                polygons = geom.polygons_full
                if not polygons: continue
                
                found_closed_shape = True
                for poly in polygons:
                    try:
                        mesh = trimesh.creation.extrude_polygon(poly, height=thickness)
                        meshes.append(mesh)
                    except Exception as e:
                        continue

        if not meshes:
            return None, found_closed_shape

        if len(meshes) > 1:
            final_mesh = trimesh.util.concatenate(meshes)
        else:
            final_mesh = meshes[0]
        
        final_mesh.fix_normals()
        return final_mesh, found_closed_shape

    except Exception as e:
        st.error(f"処理エラー: {e}")
        return None, False

def visualize_mesh(mesh):
    """
    TrimeshオブジェクトをPlotlyで3D表示する関数
    """
    # 頂点と面データの取得
    vertices = mesh.vertices
    faces = mesh.faces

    # PlotlyのMesh3dオブジェクト作成
    fig = go.Figure(data=[
        go.Mesh3d(
            x=vertices[:, 0],
            y=vertices[:, 1],
            z=vertices[:, 2],
            i=faces[:, 0],
            j=faces[:, 1],
            k=faces[:, 2],
            color='lightblue',
            opacity=1.0,
            flatshading=True
        )
    ])

    # レイアウト調整（アスペクト比を維持）
    fig.update_layout(
        scene=dict(
            xaxis=dict(visible=False),
            yaxis=dict(visible=False),
            zaxis=dict(visible=False),
            aspectmode='data'
        ),
        margin=dict(l=0, r=0, b=0, t=0)
    )
    
    return fig

# --- Streamlit UI ---

st.set_page_config(page_title="DXF/SVG to STL Converter", layout="centered")
st.title("Vector to STL Converter")
st.markdown("DXF/SVGファイルをアップロードして、3Dプレビュー・STLダウンロードができます。")

st.sidebar.header("設定")
thickness = st.sidebar.number_input("押し出し厚み (mm)", min_value=0.1, value=5.0, step=0.1, format="%.1f")

uploaded_file = st.file_uploader("ベクターファイル (DXF / SVG)", type=["dxf", "svg"])

if uploaded_file:
    file_ext = uploaded_file.name.split('.')[-1].lower()
    uploaded_file.seek(0)
    
    mesh, found_shape = process_vector_to_mesh(uploaded_file, file_ext, thickness)

    if mesh and not mesh.is_empty:
        st.success("変換成功！")
        
        # --- 3Dプレビュー表示 (Plotly) ---
        st.subheader("3D Preview")
        st.caption("マウスで回転・拡大縮小ができます")
        fig = visualize_mesh(mesh)
        st.plotly_chart(fig, use_container_width=True)

        # --- ダウンロード ---
        col1, col2 = st.columns(2)
        col1.metric("頂点数", len(mesh.vertices))
        col2.metric("面数", len(mesh.faces))
        
        stl_data = trimesh.exchange.stl.export_stl(mesh)
        st.download_button(
            label="STLファイルをダウンロード",
            data=stl_data,
            file_name=f"{uploaded_file.name.split('.')[0]}_extruded.stl",
            mime="model/stl",
            type="primary"
        )
        
    elif not found_shape:
        st.warning("⚠️ 閉じた領域が見つかりませんでした。")
        st.info("線が繋がっているか、自己交差していないかCADデータを確認してください。")
    else:
        st.error("メッシュ生成に失敗しました。")

st.caption("Powered by Streamlit & Trimesh")
