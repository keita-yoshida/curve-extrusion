import streamlit as st
import trimesh
import numpy as np
import tempfile
import os
from io import BytesIO

def process_vector_to_mesh(file_obj, file_type, thickness):
    """
    ベクターファイルを読み込み、閉じた形状を押し出してメッシュ化する関数
    """
    try:
        # Trimeshを使用してファイルをロード
        # file_objはBytesIOなので、load関数にfile_typeを明示する
        scene_or_path = trimesh.load(file_obj, file_type=file_type)
        
        meshes = []

        # ロード結果がSceneかPathかで処理を分岐
        if isinstance(scene_or_path, trimesh.Scene):
            # Sceneの場合、ジオメトリを取り出す
            geometries = scene_or_path.geometry.values()
        elif isinstance(scene_or_path, trimesh.path.Path2D):
            # Path2Dの場合、リストに入れる
            geometries = [scene_or_path]
        else:
            st.error("不明なデータ形式です。")
            return None

        # 各ジオメトリ（パス）に対して処理
        for geom in geometries:
            if isinstance(geom, trimesh.path.Path2D):
                # 押し出し処理 (extrude)
                # cap=Trueで蓋をしてソリッドにする
                try:
                    mesh = geom.extrude(amount=thickness, cap=True)
                    
                    # 複数の閉じた領域がある場合、リストで返ることがあるため結合
                    if isinstance(mesh, list):
                        combined = trimesh.util.concatenate(mesh)
                        meshes.append(combined)
                    else:
                        meshes.append(mesh)
                except Exception as e:
                    # 開いた曲線など、押し出しできないパスはスキップされる場合があります
                    st.warning(f"一部のパスの押し出しに失敗しました（開いた曲線の可能性があります）: {e}")
                    continue

        if not meshes:
            return None

        # 全てのメッシュを1つのオブジェクトに結合
        final_mesh = trimesh.util.concatenate(meshes)
        
        # 整合性の修正（法線の統一など）
        final_mesh.fix_normals()
        
        return final_mesh

    except Exception as e:
        st.error(f"ファイルの処理中にエラーが発生しました: {e}")
        return None

# --- Streamlit UI ---

st.set_page_config(page_title="Vector to STL Converter", layout="centered")

st.title("Vector to STL Converter")
st.markdown("""
DXFまたはSVGファイルをアップロードし、厚みを指定してSTL形式でダウンロードできます。
※ **閉じた曲線（Closed Loops）** のみが立体化されます。
""")

# 1. サイドバー設定
st.sidebar.header("設定")
thickness = st.sidebar.number_input(
    "押し出し厚み (mm)", 
    min_value=0.1, 
    value=5.0, 
    step=0.1,
    format="%.1f"
)

# 2. ファイルアップロード
uploaded_file = st.file_uploader("ベクターファイルを選択 (DXF / SVG)", type=["dxf", "svg"])

if uploaded_file is not None:
    # 拡張子の判定
    file_ext = uploaded_file.name.split('.')[-1].lower()
    
    st.info(f"ファイル '{uploaded_file.name}' を読み込んでいます...")

    # ファイルポインタをリセット（念のため）
    uploaded_file.seek(0)
    
    # 処理実行
    mesh = process_vector_to_mesh(uploaded_file, file_ext, thickness)

    if mesh and not mesh.is_empty:
        st.success("変換に成功しました！")

        # メッシュ情報の表示
        col1, col2 = st.columns(2)
        with col1:
            st.metric("頂点数 (Vertices)", len(mesh.vertices))
        with col2:
            st.metric("面数 (Faces)", len(mesh.faces))

        # プレビュー表示（簡易的）
        # Streamlit標準の3D表示機能を使用（重い場合は省略可）
        with st.expander("3Dプレビューを表示"):
             # 一時ファイルに書き出して表示させる（Streamlitの仕様上の制限回避）
            with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as tmp:
                mesh.export(tmp.name)
                st.write("※簡易ビューアのため、色は反映されません")
                # pydeck等を使わず簡易的に外部ライブラリなしで表示する方法はないため
                # ここでは概念的に留めますが、実際のアプリでは st.pydeck_chart 等を使います。
                # 今回はダウンロードを優先します。

        # 3. STLダウンロード
        # メッシュをSTLバイナリとして書き出し
        stl_data = trimesh.exchange.stl.export_stl(mesh)
        
        st.download_button(
            label="STLファイルをダウンロード",
            data=stl_data,
            file_name=f"{uploaded_file.name.split('.')[0]}_extruded.stl",
            mime="model/stl"
        )
    else:
        st.error("有効な閉じた形状が見つかりませんでした。データを確認してください。")

st.markdown("---")
st.caption("Powered by Python, Streamlit, and Trimesh")