# Plano — convergência de planos Go

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-artifact-id: plan-go-plan-convergence -->

## 1. Autoridade e classificação

Atualizar o digest com HGC-001/HGC-002 e implementar um classificador compartilhado que reconheça apenas a combinação Go finita, aceite imports de subpacotes e trate inventários incompletos como desconhecidos.

## 2. Portas e reparo

Conectar a regra ao parser para identidade, à consistência workspace-aware para ausência, ao staging, verificador, CLI e headless. Manter o finding reparável e a autoridade limitada ao documento nomeado.

## 3. Provas e distribuição

Cobrir variantes positivas/negativas sem Go, reparo localizado, idempotência condicional com Go e execução pelo binário empacotado. Reconstruir o plugin e encerrar somente com `npm run check` verde.
