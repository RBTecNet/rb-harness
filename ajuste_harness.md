#objeto do pedido: ajustar o rb harness para que o mesmo funcione satisfatóriamente.

#pré-requisitos:
se aprofundar no contrato do rb-ralph que será o consumidor dos artefatos gerados pelo rb-harness, para isso ler o contrato no arquivo contracts/RB-RALPH-CONTRACT.md

#O que é o rb-harness?
é uma ferramenta de linha de comando que transforma um prompt livre obtido diretamente no campo de prompt ou por meio de um arquivo de texto/markdown em artefatos que obrigatoriamente devem respeitar o contrato do rb-ralph.

#O que manter:
splash e mascote, funcionalidades existentes, dashboard, modo wizard de geração do comando, compatibilidade com agentes e modelos de IA existentes hoje no rb-harness

#O que modificar:
logica das funcionalidades que hoje nao operam de maneira satisfatória.

#como o rb-harness funciona:
Por meio de parametros, o script recebe as informações de acesso ao modelo de inteligencia artifical que pode ser atraves do prórprio cli instalado no computador do usuario ou diretamente atraves de chaves de API, essa funcionalidade ja existe no rb-harness e nao deve ser alterada, a menos que sua implementação esteja impactando negativamente na geração dos artefatos.

#como fazer:
O rb-harness deve obter o prompt que foi passado pelo usuário, encaminhar para o modelo/agente definido nos parametros de execução, o modelo por sua vez deverá levantar todos os pontos de ambiguidade e realizar o levantamento das informações faltantes ou conflitantes por meio de entrevista com o usuário, essa entrevista deverá ser realizada sequencialmente, pergunta a pergunta, e caso hajam novos pontos de duvidas novas perguntas deverão ser realizadas ate que não haja pontos de ambiguidades/duvidas com relação ao que foi proposto/solicitado
Após sanada todas os gaps, o modelo começará a gerar os artefatos dentro do contrato solicitado. todas as features devem ser quebradas em partes pequenas para que o modelo possa executar de maneira coerente, sem estourar o contexto evitando assim esquecimentos e alucinações, não criar features inteiras em um unico pedido, sempre quebrar em partes pequenas respeitando o contrato do rb-ralph.


#projetos que podem ser usados como referencia documental:
1 - /home/bruno/Documentos/Projetos/laravel/beer-and-code-harness
2 - /home/bruno/Documentos/Projetos/IA/deepseek-harness

#finalidade dos projetos de consulta
Aumentar o conhecimento de como as features do nosso harness devem funcionar, usar apenas como referencia didatica e nao como local para cópia de funcionalidades. devemos obter o melhor de ambas as ferramentas e integra-las no nosso harness porém seguindo nossos padrões e contratos, sem adicionar funcões e recursos que não atendam aos contratos estipulados, especialmente o do rb-ralph

#O que nao fazer:
1 - é proibido alterar splash, mascote
2 - é proibido remover ou adicionar funcionalidades
3 - é proibido remover o dashboard
4 - é proibid remover o modo wizard
5 - é proibido remover  compatibilidade com agentes e modelos de IA existentes hoje no rb-harness
6 - é proibido responder ao usuario em linguagem diferente da linguagem usada no prompt inicial
7 - é proibido clonar, copiar parcialmente ou integralmente os projetos definidos como projetos de consulta
