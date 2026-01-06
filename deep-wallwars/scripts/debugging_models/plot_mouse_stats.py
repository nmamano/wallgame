import matplotlib.pyplot as plt

# Data from previous calculation
data = [
    (0, 6.7751), (1, 6.9422), (2, 1.2026), (3, 0.6042), (4, 0.1958), (5, 0.4172),
    (6, 0.2272), (7, 0.2132), (8, 0.3066), (9, 0.3276), (10, 0.2093), (11, 0.2725),
    (12, 0.5566), (13, 0.1945), (14, 0.2944), (15, 0.3368), (16, 0.2862), (17, 0.3709),
    (18, 0.4204), (19, 0.4489), (20, 0.6121), (21, 0.5068), (22, 0.6447), (23, 1.0888),
    (24, 0.6522), (25, 0.7358), (26, 0.8204), (27, 0.9030), (28, 0.6463), (29, 0.7881),
    (30, 1.0218), (31, 0.9763), (32, 1.1038), (33, 0.7848), (34, 1.5567), (35, 0.8652),
    (36, 0.9236), (37, 19.1814), (38, 23.4440), (39, 38.3523), (40, 2.7407), (41, 4.3844),
    (42, 3.1780), (43, 3.6759), (44, 2.9955), (45, 5.4979), (46, 4.7652), (47, 5.0057),
    (48, 4.3691), (49, 7.2483)
]

gens, percentages = zip(*data)

plt.figure(figsize=(12, 6))
plt.plot(gens, percentages, marker='o', linestyle='-', color='b', markersize=4)

# Highlight the boost period
plt.axvspan(37, 39, color='red', alpha=0.2, label='Prior Injection Boost')

plt.title('Mouse Move Percentage by Generation (8x8 Standard)')
plt.xlabel('Generation')
plt.ylabel('Mouse Moves as % of Total Moves')
plt.grid(True, which='both', linestyle='--', linewidth=0.5)
plt.legend()

# Annotate key points
plt.annotate('Initial Simple Policy', xy=(0, 6.7), xytext=(2, 10),
             arrowprops=dict(facecolor='black', shrink=0.05))
plt.annotate('Prior Injection Start', xy=(37, 19), xytext=(20, 25),
             arrowprops=dict(facecolor='red', shrink=0.05))
plt.annotate('Stable Learning', xy=(49, 7.2), xytext=(40, 15),
             arrowprops=dict(facecolor='green', shrink=0.05))

plt.ylim(0, 45)
plt.savefig('mouse_moves_progression.png', dpi=300)
print("Plot saved as mouse_moves_progression.png")
