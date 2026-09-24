import csv
def arreglar(t):
    try: return t.encode('latin-1').decode('utf-8')
    except Exception: return t
filas=[{k:arreglar(v) for k,v in r.items()} for r in csv.DictReader(open('descargado_parte1.csv',encoding='utf-8'))]
# Genericos: el nombre ya dice la molecula
MOL={}
def m(ids,mol):
    for i in ids.split(): MOL[i]=mol
m('140216 140218 142748','Acetaminofén'); m('140220','Aciclovir'); m('140224 140225 140226','Albendazol')
m('140227 140228','Ambroxol'); m('140229 140232','Amlodipino'); m('140237 140238','Amoxicilina')
m('140240','Ampicilina'); m('140254 140255','Atenolol'); m('140263 140265','Atorvastatina')
m('140269','Azitromicina'); m('140307','Captopril'); m('140312 140313','Cefadroxilo')
m('140319','Cetirizina'); m('140328','Ciprofloxacina'); m('140334','Claritromicina')
m('140337','Clopidogrel'); m('140339','Clotrimazol + Neomicina + Dexametasona')
m('140357 140358','Desloratadina'); m('140365','Diclofenaco sódico'); m('140373 140375','Enalapril')
m('140391','Fluconazol'); m('140398','Gentamicina'); m('140402 140403 140404 140405','Glimepirida')
m('140418 140621','Ibuprofeno'); m('140435','Ketoprofeno'); m('140451','Loratadina')
m('140459','Losartán + Hidroclorotiazida'); m('140463','Losartán potásico'); m('140465 140466','Meloxicam')
m('140475 140476','Montelukast'); m('140489','Moxifloxacino'); m('140499 140501','Omeprazol')
m('140505','Piroxicam'); m('140518','Sertralina'); m('140526','Sildenafil')
m('140568','Valsartán + Hidroclorotiazida'); m('140570','Valsartán'); m('141167','Nitazoxanida')
m('141829','Betahistina'); m('142358 142361 142362','Irbesartán'); m('142635 142637','Rosuvastatina')
m('142639 142640','Diclofenaco potásico'); m('142675 142677','Carvedilol'); m('142741','Levocetirizina')
m('142905','Diosmina + Hesperidina')
# Correcciones acordadas y dosis combinadas reescritas con "+"
FIX={
 '140418':{'concentracion':'100 mg/5 ml','tamano':'60 ml'},
 '140459':{'concentracion':'50 mg + 12.5 mg'},
 '140568':{'concentracion':'80 mg + 12.5 mg'},
 '142905':{'concentracion':'450 mg + 50 mg'},
 '140495':{'nombre':'NOGINOX VAG'},
 '142682':{'nombre':'HEDRALIV','concentracion':''},
}
# Marcas con dosis: se quedan fuera hasta confirmar la molecula
PENDIENTES='140299 140346 140393 142670 140410 140440 140445 140447 140488 140495 140559 140565 140579 142730 142941 142732 142786 142789 142790 142791 142792 141806'.split()
listo=[];pend=[]
for r in filas:
    i=r['id_interno']; r.update(FIX.get(i,{}))
    if i in MOL: r['principio_activo']=MOL[i]
    (pend if i in PENDIENTES else listo).append(r)
for nombre,lista in (('recarga_parte1_LISTO.csv',listo),('pendientes_marcas.csv',pend)):
    with open(nombre,'w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(filas[0].keys())); w.writeheader(); w.writerows(lista)
print(len(listo),len(pend))
sin=[r['id_interno']+' '+r['nombre'] for r in listo if r['concentracion'] and not r['principio_activo']]
print('con dosis y sin molecula en LISTO:',sin)
print(sorted({r['forma_farmaceutica'] for r in filas}), sorted({r['laboratorio'] for r in filas}))
